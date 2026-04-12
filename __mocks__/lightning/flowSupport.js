export class FlowAttributeChangeEvent extends CustomEvent {
    constructor(name, value) {
        super("FlowAttributeChangeEvent");
        this.attributeName = name;
        this.value = value;
    }
}

export const FlowNavigationNextEvent = class extends CustomEvent {
    constructor() { super("FlowNavigationNextEvent"); }
};

export const FlowNavigationBackEvent = class extends CustomEvent {
    constructor() { super("FlowNavigationBackEvent"); }
};
