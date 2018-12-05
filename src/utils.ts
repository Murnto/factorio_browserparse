export function dumpMemUsage(tag?: string) {
    const used = Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100;
    console.log(`${tag ? tag + " " : ""}The script uses approximately ${used} MB`);
}

export function compareVersions(target: string, version: string): number {
    if (target === version) {
        return 0;
    }

    const tSplit = target.split(".");
    const vSplit = version.split(".");
    const minLength = Math.min(tSplit.length, vSplit.length);

    for (let i = 0; i < minLength; i++) {
        const t = parseInt(tSplit[i], 10);
        const v = parseInt(vSplit[i], 10);

        if (t === v) {
            continue;
        }
        if (t < v) {
            return 1;
        }
        if (t > v) {
            return -1;
        }
    }

    if (tSplit.length < vSplit.length) {
        return 1;
    }
    if (tSplit.length > vSplit.length) {
        return -1;
    }

    return 0;
}
