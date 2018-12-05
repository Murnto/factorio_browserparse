import * as JSZip from "jszip";
import * as fs from "fs";

interface ModInfo {
    name: string;
    title: string;
    author: string;
    version: string;
    description?: string;
    contact: string;
    homepage: string;
    dependencies: string[];
}

interface FactorioModDependency {
    optional: boolean;
    name: string;
    version?: string;
    relation?: string;
}

interface LuaScript {
    name: string;
    content: string;
}

export class FactorioMod {
    public info!: ModInfo;
    public luaFiles: { [index: string]: LuaScript } = {};
    public dependencies!: FactorioModDependency[];
    public luaPaths: string[] = [""];
    private loadedZip!: JSZip | null;
    private topLevelPrefix: string = "";

    public async load(zipPath: string, debugTiming: boolean = false) {
        if (debugTiming) {
            console.time(`Load zip: ${zipPath}`);
        }
        const data = fs.readFileSync(zipPath);
        if (debugTiming) {
            console.timeEnd(`Load zip: ${zipPath}`);
        }

        if (debugTiming) {
            console.time(`Parse zip: ${zipPath}`);
        }
        this.loadedZip = await new JSZip().loadAsync(data);

        this.detectToplevelFolder();
        if (debugTiming) {
            console.timeEnd(`Parse zip: ${zipPath}`);
        }

        if (debugTiming) {
            console.time(`Decompress lua scripts: ${zipPath}`);
        }
        await Promise.all(
            this.loadedZip
                .filter((relativePath, file) => relativePath.endsWith(".lua"))
                .map(async file => {
                    let name = file.name;

                    if (name.startsWith(this.topLevelPrefix)) {
                        name = name.replace(this.topLevelPrefix, "");
                    }

                    this.luaFiles[name] = {
                        content: await file.async("text"),
                        name,
                    };
                }),
        );
        if (debugTiming) {
            console.timeEnd(`Decompress lua scripts: ${zipPath}`);
        }

        const infoFile = this.loadedZip.file("info.json");
        const infoString = await infoFile.async("text");
        this.info = JSON.parse(infoString);

        (this.loadedZip as any).files = null;
        this.loadedZip = null;

        this.parseDependencies();
    }

    private parseDependencies() {
        const depPattern = /^(?:(\?)\s*)?(.*?)(?:\s*(<=|=|>=)\s*(.*?))?$/;

        this.dependencies = [];

        if (this.info.dependencies === undefined) {
            return;
        }

        for (const dep of this.info.dependencies) {
            const match = dep.match(depPattern);

            if (match !== null) {
                this.dependencies.push({
                    name: match[2],
                    optional: match[1] === "?",
                    relation: match[3],
                    version: match[4],
                });
            } else {
                throw new Error(`Failed to parse dependency "${dep}"`);
            }
        }
    }

    private detectToplevelFolder() {
        // let found: JSZip.JSZipObject | null = null;

        for (const file of Object.values(this.loadedZip!.files)) {
            if (file.name.endsWith("info.json") && file.name.indexOf("/") === file.name.lastIndexOf("/")) {
                this.topLevelPrefix = file.name.slice(0, file.name.lastIndexOf("info.json"));

                // console.info(`Using toplevel folder ${this.topLevelPrefix}`);
                this.loadedZip = this.loadedZip!.folder(this.topLevelPrefix);
            }
        }
    }
}