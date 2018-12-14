import { FactorioPack } from "./factorioPack";
import { hex } from "js-md5";
import { FactorioMod } from "./factorioMod";
import * as fs from "fs";

async function getModFileHash(mod: FactorioMod, iconPath: string): Promise<string> {
    const data = await mod.getFile(iconPath, "uint8array");
    const extension = iconPath.slice(iconPath.lastIndexOf(".") + 1);
    const md5 = hex(data);

    await fs.writeFileSync(`icon/${md5}.${extension}`, data);

    return md5;
}

export class IconManager {
    private hashLookup: { [path: string]: string } = {};
    private promisedHashLookup: { [path: string]: Promise<string> } = {};

    constructor(private pack: FactorioPack) {}

    public async resolveIcon(icon: string): Promise<string> {
        if (this.hashLookup[icon] !== undefined) {
            return this.hashLookup[icon];
        }
        if (this.promisedHashLookup[icon] !== undefined) {
            return await this.promisedHashLookup[icon];
        }

        const modName = icon.split("__", 3)[1];
        const mod = this.pack.mods[modName];

        if (!mod) {
            throw new Error(`Failed to find mod "${modName}" for icon "${icon}"`);
        }

        const iconPath = icon.slice(icon.indexOf("/") + 1);
        const md5Promise = getModFileHash(mod, iconPath);

        this.promisedHashLookup[icon] = md5Promise;

        const md5 = await md5Promise;

        // console.log(`${icon} = ${md5}`);

        this.hashLookup[icon] = md5;

        return md5;
    }
}
