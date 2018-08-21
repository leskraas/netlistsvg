import { YosysNetlist, CellAttributes, Signals, IYosysModule } from './YosysModel';
import { getProperties, findSkinType, getLateralPortPids } from './skin';
import { Cell } from './Cell';
import _ = require('lodash');

export interface IFlatPort {
    key: string;
    value?: number[] | Signals;
    parentNode?: ICell;
    wire?: IWire;
}

export interface IWire {
    drivers: IFlatPort[];
    riders: IFlatPort[];
    laterals: IFlatPort[];
}

export interface ICell {
    key: string;
    type: string;
    inputPorts: IFlatPort[];
    outputPorts: IFlatPort[];
    attributes?: CellAttributes;
}

export class FlatModule {
    private moduleName: string;
    private nodes: Cell[];
    private wires: IWire[];
    private skin: any;

    constructor(netlist: YosysNetlist, skin: any) {
        this.moduleName = null;
        _.forEach(netlist.modules, (mod: IYosysModule, name: string) => {
            if (mod.attributes && mod.attributes.top === 1) {
                this.moduleName = name;
            }
        });
        // Otherwise default the first one in the file...
        if (this.moduleName == null) {
            this.moduleName = Object.keys(netlist.modules)[0];
        }
        const top = netlist.modules[this.moduleName];
        const ports = _.map(top.ports, Cell.fromPort);
        const cells = _.map(top.cells, (c, key) => Cell.fromYosysCell(c, key, skin));
        this.nodes = cells.concat(ports);
        // populated by createWires
        this.wires = [];
        this.skin = skin;
    }

    public getNodes(): Cell[] {
        return this.nodes;
    }

    public getWires(): IWire[] {
        return this.wires;
    }

    public getName(): string {
        return this.moduleName;
    }

    public getSkin(): any {
        return this.skin;
    }

    // converts input ports with constant assignments to constant nodes
    public addConstants(): void {
        // find the maximum signal number
        let maxNum: number = this.nodes.reduce(((acc, v) => v.maxOutVal(acc)), -1);

        // add constants to nodes
        const signalsByConstantName: SigsByConstName = {};
        const cells: Cell[] = [];
        this.nodes.forEach((n) => {
            maxNum = n.findConstants(signalsByConstantName, maxNum, cells);
        });
        this.nodes = this.nodes.concat(cells);
    }

    // solves for minimal bus splits and joins and adds them to module
    public addSplitsJoins() {
        const allInputs = _.flatMap(this.nodes, (n) => n.inputPortVals());
        const allOutputs = _.flatMap(this.nodes, (n) => n.outputPortVals());

        const allInputsCopy = allInputs.slice();
        const splits: SplitJoin = {};
        const joins: SplitJoin = {};
        allInputs.forEach((input) => {
            gather(
                allOutputs,
                allInputsCopy,
                input,
                0,
                input.length,
                splits,
                joins);
        });

        this.nodes = this.nodes.concat(_.map(joins, (joinOutput, joinInputs) => {
            return Cell.fromJoinInfo(joinInputs, joinOutput);
        })).concat(_.map(splits, (splitOutputs, splitInput) => {
            return Cell.fromSplitInfo(splitInput, splitOutputs);
        }));
    }

    // search through all the ports to find all of the wires
    public createWires() {
        const layoutProps = getProperties(this.skin);
        const ridersByNet: NameToPorts = {};
        const driversByNet: NameToPorts = {};
        const lateralsByNet: NameToPorts = {};
        this.nodes.forEach((n) => {
            const template = findSkinType(this.skin, n.type);
            const lateralPids = getLateralPortPids(template);
            // find all ports connected to the same net
            n.inputPorts.forEach((port) => {
                port.parentNode = n;
                const portSigs: number[] = port.value as number[];
                const isLateral = lateralPids.indexOf(port.key) !== -1;
                if (isLateral || (template[1]['s:type'] === 'generic' && layoutProps.genericsLaterals)) {
                    addToDefaultDict(lateralsByNet, arrayToBitstring(portSigs), port);
                } else {
                    addToDefaultDict(ridersByNet, arrayToBitstring(portSigs), port);
                }
            });
            n.outputPorts.forEach((port) => {
                port.parentNode = n;
                const portSigs: number[] = port.value as number[];
                const isLateral = lateralPids.indexOf(port.key) !== -1;
                if (isLateral || (template[1]['s:type'] === 'generic' && layoutProps.genericsLaterals)) {
                    addToDefaultDict(lateralsByNet, arrayToBitstring(portSigs), port);
                } else {
                    addToDefaultDict(driversByNet, arrayToBitstring(portSigs), port);
                }
            });
        });
        // list of unique nets
        const nets = removeDups(_.keys(ridersByNet).concat(_.keys(driversByNet)).concat(_.keys(lateralsByNet)));
        const wires: IWire[] = nets.map((net) => {
            const drivers: IFlatPort[] = driversByNet[net] || [];
            const riders: IFlatPort[] = ridersByNet[net] || [];
            const laterals: IFlatPort[] = lateralsByNet[net] || [];
            const wire: IWire = { drivers, riders, laterals};
            drivers.concat(riders).concat(laterals).forEach((port) => {
                port.wire = wire;
            });
            return wire;
        });
        this.wires = wires;
    }
}

export interface SigsByConstName {
    [constantName: string]: number[];
}

// returns a string that represents the values of the array of integers
// [1, 2, 3] -> ',1,2,3,'
function arrayToBitstring(bitArray: number[]): string {
    let ret: string = '';
    bitArray.forEach((bit: number) => {
        const sbit = String(bit);
        if (ret === '') {
            ret = sbit;
        } else {
            ret += ',' + sbit;
        }
    });
    return ',' + ret + ',';
}

// returns whether needle is a substring of haystack
function arrayContains(needle: string, haystack: string | string[]): boolean {
    return (haystack.indexOf(needle) > -1);
}

// returns the index of the string that contains a substring
// given arrhaystack, an array of strings
function indexOfContains(needle: string, arrhaystack: string[]): number {
    return _.findIndex(arrhaystack, (haystack: string) => {
        return arrayContains(needle, haystack);
    });
}

export function getBits(signals: Signals, indicesString: string) {
    const index = indicesString.indexOf(':');
    // is it the whole thing?
    if (index === -1) {
        return [signals[Number(indicesString)]];
    } else {
        const start = indicesString.slice(0, index);
        const end = indicesString.slice(index + 1);
        const slice = signals.slice(Number(start), Number(end) + 1);
        return slice;
    }
}

interface SplitJoin {
    [portName: string]: string[];
}

function addToDefaultDict(dict: any, key: string, value: any) {
    if (dict[key] === undefined) {
        dict[key] = [value];
    } else {
        dict[key].push(value);
    }
}

// string (for labels), that represents an index
// or range of indices.
function getIndicesString(bitstring: string, query: string, start: number): string {
    const splitStart: number = _.max([bitstring.indexOf(query), start]);
    const startIndex: number = bitstring.substring(0, splitStart).split(',').length - 1;
    const endIndex: number = startIndex + query.split(',').length - 3;

    if (startIndex === endIndex) {
        return String(startIndex);
    } else {
        return String(startIndex) + ':' + String(endIndex);
    }
}

// gather splits and joins
function gather(inputs: string[],  // all inputs
                outputs: string[], // all outputs
                toSolve: string, // an input array we are trying to solve
                start: number,   // index of toSolve to start from
                end: number,     // index of toSolve to end at
                splits: SplitJoin,  // container collecting the splits
                joins: SplitJoin) {  // container collecting the joins
    // remove myself from outputs list if present
    const outputIndex: number = outputs.indexOf(toSolve);
    if (outputIndex !== -1) {
        outputs.splice(outputIndex, 1);
    }

    // This toSolve is compconste
    if (start >= toSolve.length || end - start < 2) {
        return;
    }

    const query: string = toSolve.slice(start, end);

    // are there are perfect matches?
    if (arrayContains(query, inputs)) {
        if (query !== toSolve) {
            addToDefaultDict(joins, toSolve, getIndicesString(toSolve, query, start));
        }
        gather(inputs, outputs, toSolve, end - 1, toSolve.length, splits, joins);
        return;
    }
    const index: number = indexOfContains(query, inputs);
    // are there any partial matches?
    if (index !== -1) {
        if (query !== toSolve) {
            addToDefaultDict(joins, toSolve, getIndicesString(toSolve, query, start));
        }
        // found a split
        addToDefaultDict(splits, inputs[index], getIndicesString(inputs[index], query, 0));
        // we can match to this now
        inputs.push(query);
        gather(inputs, outputs, toSolve, end - 1, toSolve.length, splits, joins);
        return;
    }
    // are there any output matches?
    if (indexOfContains(query, outputs) !== -1) {
        if (query !== toSolve) {
            // add to join
            addToDefaultDict(joins, toSolve, getIndicesString(toSolve, query, start));
        }
        // gather without outputs
        gather(inputs, [], query, 0, query.length, splits, joins);
        inputs.push(query);
        return;
    }
    gather(inputs, outputs, toSolve, start, start + query.slice(0, -1).lastIndexOf(',') + 1, splits, joins);
}

interface NameToPorts {
    [netName: string]: IFlatPort[];
}

interface StringToBool {
    [s: string]: boolean;
}

export function removeDups(inStrs: string[]) {
    const map: StringToBool = {};
    inStrs.forEach((str) => {
        map[str] = true;
    });
    return _.keys(map);
}
