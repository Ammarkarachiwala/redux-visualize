import * as functions from './functions';
import * as constants from './constants';
import { RESELECT_SELECTOR } from '../vis/constants';
import React from 'react';



class Node {
    constructor(id, name, type) {
        this.id = id;
        this.name = name;
        this.type = type;
        this.indexedDependencies = {};
        this.dispatchId = -1;
        this.value = undefined;
    }

    addDependency(node) {
        if (!(node.id in this.indexedDependencies)) {
            this.indexedDependencies[node.id] = node;
        }
    }

    setValue(value) {
        this.value = value;
    }

    setDispatchId(id) {
        this.dispatchId = id;
    }

    serialize() {
        const result = {...this};
        delete result.indexedDependencies;
        result.dependencies = Object.keys(this.indexedDependencies);
        try {
            JSON.stringify(result.value);
        } catch (e) {
            result.value = 'Failed to Serialize';
        }
        try {
            result.stringifiedResult = JSON.stringify(result.value);
        } catch (e) {
            result.stringifiedResult = 'Failed to Serialize';
        }
        return result;
    }
}

class Graph {
    constructor() {
        this.stack = [];
        this.indexedNodes = {};
        this.store = null;
        this.dispatchId = 0;
        this.ctx = React.createContext(null);

        window.addEventListener('message', (event) => {
            if (event.data === 'GRAPH_REQUESTED') {
                this.displayGraphInExtension();
            }
            return true;
        });
    }

    getNodeById(id) {
        return this.indexedNodes[id];
    }

    displayGraphInExtension() {
        const message = {
            type: 'GRAPH_SENT',
            graph: this.serializeGraph(),
        };
        window.postMessage(message, '*')
    }

    serializeGraph() {
        const result = Object.keys(this.indexedNodes)
            .map(key => this.indexedNodes[key])
            .map((node) => node.serialize());

        return result;
    }

    addNode(node) {
        this.indexedNodes[node.id] = node;
    }

    makeStateWatchableMemoized(obj) {
        if (this.cachedState === obj) return this.cachedWatchableState;
        const result = this.makeStateWatchable(obj);
        this.cachedState = obj;
        this.cachedWatchableState = result;
        return result;
    }

    makeStateWatchable(obj) {
        return this.makeStateWatchableHelper(obj, 0, [])
    }

    makeStateWatchableHelper(obj, depth, historyKeys) {
        const newObj = {};
        const keys = Object.keys(obj);
        const stack = this.stack;
        
        for (const key of keys) {
            const newKeys = [...historyKeys, key];
            const name = functions.getStateVariableName(newKeys);
            const type = constants.STATE_VARIABLE;
            const node = new Node(name, name, type);
            

            const child = (typeof obj[key] === 'object' && obj[key] !== null)
                ? this.makeStateWatchableHelper(obj[key], depth + 1, newKeys)
                : obj[key];

            const getterFunc = () => child;

            Object.defineProperty(newObj, key, {
                get: () => {
                    this.addNode(node);
                    stack.push(node);
                    const result = getterFunc();
                    node.setValue(result);
                    node.setDispatchId(this.dispatchId);
                    const currNode = stack.pop();
                    if (stack.length > 0) {
                        stack[stack.length - 1].addDependency(currNode);
                    }
                    return result;
                },
                enumerable: true,
            });
        }
        return newObj;
    }

    watchReduxStore(store) {
        const get = store.getState;
        store.getState = (...params) => {
            const state = get(...params);
            const watchable = this.makeStateWatchableMemoized(state)
            return watchable;
        }
        const disp = store.dispatch;
        store.dispatch = (...params) => {
            this.dispatchId += 1;
            const result = disp(...params);
            return result;
        }
        this.store = store;
        return store;
    }

    inject(f, name, type) {
        const stack = this.stack;
        const id = functions.make_id();
        const node = new Node(id, name, type);
        this.addNode(node);
        return (...d) => {
            stack.push(node)
            const result = f(...d);
            node.setValue(result);
            node.setDispatchId(this.dispatchId);
            const currNode = stack.pop();
            if (stack.length > 0) {
                stack[stack.length - 1].addDependency(currNode);
            }
            return result;
        }
    }

    vis(f, defaultName=null) {
        const type = functions.getType(f);
        if (type === constants.RESELECT_SELECTOR) {
            return (...funcs) => {
                const selector = f(...funcs);
                const mainFunction = funcs.pop();
                const name = functions.getFunctionName(mainFunction, defaultName);
                return this.inject(selector, name, type);
            };
        } else if (type === constants.ASYNC_SELECTOR) {
            return (obj, ...funcs) => {
                const selector = f(obj, ...funcs);
                const mainFunction = obj.async;
                const name = functions.getFunctionName(mainFunction, defaultName);
                return this.inject(selector, name, type);
            }
        } else if (type === constants.CONNECT) {

/*

        const stack = this.stack;
        const id = functions.make_id();
        const node = new Node(id, name, type);
        this.addNode(node);
        return (...d) => {
            stack.push(node)
            const result = f(...d);
            node.setValue(result);
            node.setDispatchId(this.dispatchId);
            const currNode = stack.pop();
            if (stack.length > 0) {
                stack[stack.length - 1].addDependency(currNode);
            }
            return result;
        }
*/
            return (mapState_, mapDispatch) => (Component) => {
                const mapState = mapState_ || (() => ({}));
                const self = this;
                const stack = this.stack;
                const id = functions.make_id();
                const name = functions.getNameFromComponent(Component, defaultName);
                const node = new Node(id, name, type);
                self.addNode(node);
                const ParentContext = self.ctx;

                const ComponentWithParent = (props) => {
                    const state = self.store.getState();
                    stack.push(node)
                    node.setValue(mapState(state), props)
                    node.setDispatchId(self.dispatchId);
                    const currNode = stack.pop();
                    if (stack.length > 0) {
                        stack[stack.length - 1].addDependency(currNode);
                    }
                    return (
                        <ParentContext.Consumer>
                            {
                                (parentId) => {
                                    if (parentId !== null) {
                                        const parentNode = self.getNodeById(parentId);
                                        parentNode.addDependency(node);
                                    }
                                    return <ParentContext.Provider value={node.id}>
                                        <Component {...props} />
                                    </ParentContext.Provider>
                                }
                            }
                        </ParentContext.Consumer>
                    );
                }

                
                return f(mapState, mapDispatch)(ComponentWithParent);
            }
        } else if (type === constants.FUNCTION) {
            const name = functions.getFunctionName(f, defaultName);
            return this.inject(f, name, type);
        }
    }
}

const graph = new Graph();
setInterval(() => console.log(graph), 2000);

export default graph;