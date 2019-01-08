import { FactorioMod } from "./factorioMod";

export class ModDependencyError extends Error {
    public mod: FactorioMod | undefined;

    constructor(m: string, mod?: FactorioMod) {
        super(m);

        this.mod = mod;

        // Set the prototype explicitly.
        Object.setPrototypeOf(this, ModDependencyError.prototype);
    }
}
