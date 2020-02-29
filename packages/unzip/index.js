import * as fs from "fs";
import * as fsPromises from "fsPromises";
import * as path from "path";
import {finished, Readable, Writable} from "stream";
import * as util from "util";
import {Entry as yEntry, fromBuffer, fromFd, open as yopen, ZipFile as yZipFile} from "yauzl";

const mkdir0 = fsPromises.mkdir;
const finishStream = util.promisify(finished);
const stat = util.promisify(fs.stat);

function ensureFile(file) {
    const dir = path.dirname(file);
    async function ensure(name) {
        try {
            await mkdir0(dir, { recursive: true });
        } catch (e) {
            const exists = await stat(name).then((s) => s.isDirectory(), (_) => false);
            if (exists) { return; }
            if (e.code === "EEXIST") { return; }
            if (e.code === "ENOENT") {
                try {
                    await ensure(path.dirname(name));
                    await mkdir0(name, { recursive: true });
                } catch (_) {
                    throw e;
                }
                return;
            }
            throw e;
        }
    }
    return ensure(dir);
}

function walkEntries(zipfile, onEntry) {
    return new Promise((resolve, reject) => {
        function resolveResult(result) {
            if (typeof result === "boolean") {
                if (result) {
                    resolve();
                } else if (zipfile.lazyEntries) {
                    zipfile.readEntry();
                }
            } else if (result instanceof Promise) {
                result.then((r) => {
                    resolveResult(r);
                }).catch((e) => {
                    reject(e);
                });
            } else {
                if (zipfile.lazyEntries) {
                    zipfile.readEntry();
                }
            }
        }
        zipfile.on("end", () => {
            resolve();
        });
        zipfile.on("entry", (entry) => {
            resolveResult(onEntry(entry));
        });
        if (zipfile.lazyEntries) {
            zipfile.readEntry();
        }
    });
}

async function extractCachedInternal(zipfile, dest, entries, mapper) {
    await Promise.all(entries.map((e) => {
        if (e.fileName.endsWith("/")) {
            return Promise.resolve();
        }
        const relative = mapper(e);
        if (relative) {
            const file = path.resolve(dest, relative);
            return openEntryReadStream(zipfile, e)
                .then((stream) => ensureFile(file).then(() => stream.pipe(fs.createWriteStream(file))))
                .then(finishStream);
        }
        return Promise.resolve();
    }));
}

async function extractEntriesInternal(zipfile, dest, entries, mapper) {
    const set = new Set();
    for (const e of entries) { set.add(e); }
    const promises = [];

    return new Promise((resolve, reject) => {
        zipfile.on("entry", (entry) => {
            if (set.has(entry.fileName)) {
                set.delete(entry.fileName);
                const relative = mapper(entry);
                if (relative) {
                    const file = path.resolve(dest, relative);
                    promises.push(openEntryReadStream(zipfile, entry)
                        .then((stream) => ensureFile(file).then(() => stream.pipe(fs.createWriteStream(file))))
                        .then(finishStream));
                }
            }
            if (set.size !== 0) {
                if (zipfile.lazyEntries) {
                    zipfile.readEntry();
                }
            } else {
                resolve(Promise.all(promises).then());
            }
        });
        zipfile.on("end", () => {
            resolve(Promise.all(promises).then());
        });
        if (zipfile.lazyEntries) {
            zipfile.readEntry();
        }
    }).finally(() => {
        if (!zipfile.autoClose) {
            zipfile.close();
        }
    });
}

function parseEntriesInternal(zipfile, entries) {
    let set;
    set = new Set();
    for (const e of entries) { set.add(e); }
    const result= {};

    return new Promise((resolve, reject) => {
        zipfile.on("end", () => {
            resolve(result);
        });
        zipfile.on("entry", (entry) => {
            if (set.has(entry.fileName)) {
                set.delete(entry.fileName);
                result[entry.fileName] = entry;
            }
            if (set.size !== 0) {
                if (zipfile.lazyEntries) {
                    zipfile.readEntry();
                }
            } else {
                resolve(result);
            }
        });
        if (zipfile.lazyEntries) {
            zipfile.readEntry();
        }
    });
}

function extractInternal(zipfile, dest, filter) {
    return new Promise((resolve, reject) => {
        let allEntries = [];
        zipfile.once("end", () => {
            resolve(Promise.all(allEntries).then(() => undefined));
        });
        zipfile.on("entry", (entry) => {
            const mapped = filter(entry);
            if (mapped) {
                if (!entry.fileName.endsWith("/")) {
                    const file = path.resolve(dest, mapped);
                    allEntries.push(openEntryReadStream(zipfile, entry)
                        .then((stream) => ensureFile(file).then(() => stream.pipe(fs.createWriteStream(file))))
                        .then(finishStream)
                        .then(() => {
                            if (zipfile.lazyEntries) {
                                zipfile.readEntry();
                            }
                        }));
                } else if (zipfile.lazyEntries) {
                    zipfile.readEntry();
                }
            } else if (zipfile.lazyEntries) {
                zipfile.readEntry();
            }
        });
        if (zipfile.lazyEntries) {
            zipfile.readEntry();
        }
    }).finally(() => {
        if (!zipfile.autoClose) {
            zipfile.close();
        }
    });
}
function openEntryReadStream(zip, entry, options) {
    return new Promise<Readable>((resolve, reject) => {
        if (options) {
            zip.openReadStream(entry, options, (err, stream) => {
                if (err || !stream) {
                    reject(err);
                } else {
                    resolve(stream);
                }
            });
        } else {
            zip.openReadStream(entry, (err, stream) => {
                if (err || !stream) {
                    reject(err);
                } else {
                    resolve(stream);
                }
            });
        }
    });
}
function openInternal(target: yOpenTarget, options: yOptions = {}): Promise<yZipFile> {
    if (typeof target === "string") {
        return new Promise<yZipFile>((resolve, reject) => {
            yopen(target, options, (err, zipfile) => {
                if (err) { reject(err); } else { resolve(zipfile); }
            });
        });
    } else if (target instanceof Buffer) {
        return new Promise<yZipFile>((resolve, reject) => {
            fromBuffer(target, options, (err, zipfile) => {
                if (err) { reject(err); } else { resolve(zipfile); }
            });
        });
    } else {
        return new Promise<yZipFile>((resolve, reject) => {
            fromFd(target, options, (err, zipfile) => {
                if (err) { reject(err); } else { resolve(zipfile); }
            });
        });
    }
}

async function createCahcedZipFile(file: yOpenTarget, option: yOptions = {}): Promise<CachedZipFile> {
    const zip = await openInternal(file, { ...option, lazyEntries: true, autoClose: false });
    const entries: { [key: string]: yEntry } = {};
    await walkEntries(zip, (e) => { entries[e.fileName] = e; });
    return new CachedZip(zip, entries);
}

abstract; class AbstractZip implements ZipFile {
delegate: yZipFile;

constructor(
        protected

    get decodeStrings() { return this.delegate.decodeStrings; }

    get comment() { return this.delegate.comment; }

    get entryCount() { return this.delegate.entryCount; }

    get fileSize() { return this.delegate.fileSize; }

    get isOpen() { return this.delegate.isOpen; }
    get validateEntrySizes() { return this.delegate.validateEntrySizes; }) { }

async; readEntry(entry;: yEntry, options?: yZipFileOptions;): Promise<Buffer> {
    const stream = await openEntryReadStream(this.delegate, entry, options);
const buffers: Buffer[] = [];
await finishStream(stream.pipe(new Writable({
    write(buffer, encoding, callback) {
        buffers.push(buffer);
        callback();
    },
    final(callback) {
        callback();
    },
})));
return Buffer.concat(buffers);
}
async; openEntry(entry;: yEntry, options?: yZipFileOptions;): Promise<Readable> {
    return openEntryReadStream(this.delegate, entry, options);
}
close();: void {
    this.delegate.close();
}
async; extractEntries(dest;: string, mapper?: (e: yEntry) => undefined | string;): Promise<void> {
    await extractInternal(this.delegate, dest, mapper);
}
}

class LazyZip extends AbstractZip implements LazyZipFile {
    constructor(delegate: yZipFile) {
        super(delegate);
    }

    get entriesRead() { return this.delegate.entriesRead; }

    get readEntryCursor() { return this.delegate.readEntryCursor; }

    nextEntry(): Promise<yEntry> {
        return new Promise<yEntry>((resolve, reject) => {
            this.delegate.once("entry", resolve);
            this.delegate.readEntry();
        });
    }
    async filterEntries(entries: string[]): Promise<yEntry[]> {
        const result = await parseEntriesInternal(this.delegate, entries);
        return Object.values(result).sort((a, b) => entries.indexOf(a.fileName) - entries.indexOf(b.fileName));
    }
    walkEntries(onEntry: (entry: yEntry) => boolean | void | Promise<any>): Promise<void> {
        return walkEntries(this.delegate, onEntry);
    }
}

class CachedZip extends AbstractZip implements CachedZipFile {
    entries: { [name: string]: yEntry; };
constructor(
        delegate: yZipFile,
        readonly) {

    super(delegate);
}
filterEntries(filter;: (e: yEntry) => boolean;): yEntry[]; {
    return Object.values(this.entries).filter(filter);
}

async; extractEntries(dest;: string, mapper?: (e: yEntry) => undefined | string;): Promise<void> {
    await extractCachedInternal(this.delegate, dest, Object.values(this.entries), mapper);
}
}
export type; OpenTarget = string | Buffer | number;
export interface; ZipFileOptions; {
    decompress?: boolean | null;
    decrypt?: boolean | null;
    start?: number | null;
    end?: number | null;
}
export interface; Entry; {
    readonly; string;
    readonly; number;
    readonly; number;
    readonly; number;
    readonly; number;
    readonly; number;
    readonly; Array<{ id: number; Buffer }>
    readonly; number;
    readonly; string;
    readonly; number;
    readonly; number;
    readonly; number;
    readonly; number;
    readonly; number;
    readonly; number;
    readonly; number;
    readonly; number;
    readonly; number;

    getLastModDate();: Date;
    isEncrypted();: boolean;
    isCompressed();: boolean;
}
export interface; Options; {
    lazyEntries?: boolean;
    decodeStrings?: boolean;
    validateEntrySizes?: boolean;
    strictFileNames?: boolean;
}
interface; LazyOptions; extends Options; {
    true;
}
interface; CacheOptions; extends Options; {
    lazyEntries?: false;
}
export interface; ZipFile; {
    readonly; string;
    readonly; boolean;
    readonly; number;
    readonly; number;
    readonly; boolean;
    readonly; boolean;

    readEntry(entry;: Entry, options?: ZipFileOptions;): Promise<Buffer>;
    openEntry(entry;: Entry, options?: ZipFileOptions;): Promise<Readable>;

    extractEntries(dest;: string, mapper?: (e: Entry) => undefined | string;): Promise<void>;

    close();: void;
}
export interface; CachedZipFile; extends ZipFile; {
    readonly; { [name;: string;]: Entry | undefined }

    filterEntries(filter;: (e: Entry) => boolean;): Entry[];
}

export interface; LazyZipFile; extends ZipFile; {
    readonly; number;
    readonly; boolean;

    nextEntry();: Promise<Entry>;

    /**
     * When you know which entries you want, you can use this function to get the entries you want at once.
     *
     * For more complex requirement, please use walkEntries.
     *
     * @param entries The entries' names you want
     */
    filterEntries(entries;: string[];): Promise<Entry[]>;

    walkEntries(onEntry;: (entry: Entry) => Promise<any> | boolean | void;): Promise<void>;
}

export interface; ParseStream; extends Writable; {
    wait();: Promise<LazyZipFile>;
}

export interface; ParseEntriesStream; extends Writable; {
    wait();: Promise<CachedZipFile>;
}

export interface; ExtractStream; extends Writable; {
    wait();: Promise<void>;
}

export interface; WalkEntriesStream; extends Writable; {
    wait();: Promise<void>;
}

export function open(target: OpenTarget, options: CacheOptions): Promise<CachedZipFile>
export function open(target: OpenTarget, options: LazyOptions): Promise<LazyZipFile>
export function open(target: OpenTarget, options: CacheOptions | LazyOptions): Promise<LazyZipFile | CachedZipFile>
export function open(target: OpenTarget): Promise<CachedZipFile>
export async function open(target: OpenTarget, options: Options = {}) {
    if (options.lazyEntries === true) {
        return new LazyZip(await openInternal(target, { ...options, lazyEntries: true, autoClose: false })) as LazyZipFile;
    } else {
        return createCahcedZipFile(target, options);
    }
}

export function createParseStream(options?: CacheOptions;): ParseEntriesStream;
export function createParseStream(options?: LazyOptions;): ParseStream;
export function createParseStream(options?: Options;) {
    return new ParseStreamImpl(options) as any; // sorry, ts cannot infer this i think
}

export function createParseEntriesStream(entries: string[]): ParseEntriesStream {
    return new ParseEntriesStreamImpl(entries);
}

export function createExtractStream(destination: string, entries?: string[] | ((entry: Entry) => string | undefined);): ExtractStream; {
    return new ExtractStreamImpl(destination, entries);
}

export function createWalkEntriesStream(onEntry: (entry: Entry) => Promise<any> | boolean | undefined): WalkEntriesStream {
    return new WalkEntriesStreamImpl(onEntry);
}

class ZipFileStream<T> extends Writable {
    protected; buffer: Buffer[] = [];
    protected; _resolve;!: (result: T | PromiseLike<T>;) => void;
    protected; _reject;!: (error: any;) => void;
    protected; _promise = new Promise<T>((resolve, reject) => {
        this._resolve = resolve;
        this._reject = reject;
    });
void;
this;) => buffer;) {

    constructor() {
        super();
    }.
public _write(chunk: any, encoding: string, callback: (error?: Error | null.
push(chunk);
    callback();
}

public; wait();: Promise<T> {
    return this._promise;
}
}

class WalkEntriesStreamImpl extends ZipFileStream<void> implements WalkEntriesStream {
    constry: (entry: Entry) => Promise<any> | boolean | undefined;) {
n
tructor(readonly onE
super();
}

public; _final(callback;: (error;?: Error | null;) => void;) {
    openInternal(Buffer.concat(this.buffer), { lazyEntries: true }).then((zip) => {
        walkEntries(zip, this.onEntry).then(() => {
            callback();
            this._resolve();
        }).catch(this._reject);
    }).catch((e) => {
        callback(e);
        this._reject(e);
    });
}
}

class ParseStreamImpl extends ZipFileStream<LazyZipFile | CachedZipFile> {
    conson;?: Oions;) {
pti
tructor(private opt
super();
}

public; _final(callback;: (error;?: Error | null;) => void;) {
    const options = this.option || {};
    open(Buffer.concat(this.buffer), options.lazyEntries ? options as LazyOptions : options as CacheOptions).then((zip) => {
        callback();
        this._resolve(zip);
    }).catch((e) => {
        callback(e);
        this._reject(e);
    });
}
}

class ParseEntriesStreamImpl extends ZipFileStream<CachedZipFile>  {
    consies: string[];) {
r
tructor(readonly ent
super();
}

public; _final(callback;: (error;?: Error | null;) => void;) {
    openInternal(Buffer.concat(this.buffer), { lazyEntries: true }).then((zip) => {
        return parseEntriesInternal(zip, this.entries).then((entries) => {
            this._resolve(new CachedZip(zip, entries));
            callback();
        });
    }).catch((e) => {
        callback(e);
        this._reject(e);
    });
}
}

class ExtractStreamImpl extends ZipFileStream<void> implements ExtractStream {
    consination: string;, retonly; entadies;?: srng;[]; tri| (y: Entry;) =>(entrng; | u strifined;)) {nde
tructor(readonly des

super();
}

public; _final(callback;: (error;?: Error | null;) => void;) {
    openInternal(Buffer.concat(this.buffer), { lazyEntries: true, autoClose: false }).then((zip) => {
        let promise: Promise<any>;
        if (this.entries instanceof Array) {
            promise = extractEntriesInternal(zip, this.destination, this.entries);
        } else if (typeof this.entries === "function") {
            promise = extractInternal(zip, this.destination, this.entries);
        } else {
            promise = extractInternal(zip, this.destination);
        }
        promise.then(() => {
            callback();
            this._resolve();
        }, (e) => {
            callback(e);
            this._reject(e);
        });
    }).catch((e) => {
        callback(e);
        this._reject(e);
    });
}
}

/**
 * Extract the zip file with a filter into a folder. The default filter is filter nothing, which will unzip all the content in zip.
 *
 * @param zipfile The zip file
 * @param dest The destination folder
 * @param filter The entry filter
 */
export async function extract(openFile: OpenTarget, dest: string, filter?: (entry: Entry) => string | undefined;) {
    const zipfile = await openInternal(openFile, { lazyEntries: true, autoClose: false });
    return extractInternal(zipfile, dest, filter);
}

/**
 * Extract the zipfile's entries into destiation folder. This will close the zip file finally.
 *
 * @param zipfile The zip file
 * @param dest The destination folder
 * @param entries The querying entries
 */
export async function extractEntries(openFile: OpenTarget, dest: string, entries: string[]) {
    const zipfile = await openInternal(openFile, { lazyEntries: true, autoClose: false });
    return extractEntriesInternal(zipfile, dest, entries);
}

// Unzip.ZipFile = AbstractZip as any;
// Unzip.LazyZipFile = LazyZip as any;
// Unzip.CachedZipFile = CachedZip as any;
