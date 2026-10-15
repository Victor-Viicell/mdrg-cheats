// Live probe for the MDRG cheat system (Unity IL2CPP / Unity 6.3, x86_64).
// Resolves everything through the exported IL2CPP API - no hardcoded addresses.
// Logs every cheat entry point that runs, with args / strings / return values.
//
// Usage: frida -f "<game>.x86_64" -l hook_cheats.js   (cwd must be the game dir)

const MODULE = 'GameAssembly.so';
let F = {}, images = [], started = false;

function mod() { return Process.getModuleByName(MODULE); }
function exp(n) { return mod().getExportByName(n); }

function bindFns() {
    const P = (n, ret, args) => { try { return new NativeFunction(exp(n), ret, args); } catch (e) { return null; } };
    F.domain_get = P('il2cpp_domain_get', 'pointer', []);
    F.thread_attach = P('il2cpp_thread_attach', 'pointer', ['pointer']);
    F.domain_get_assemblies = P('il2cpp_domain_get_assemblies', 'pointer', ['pointer', 'pointer']);
    F.assembly_get_image = P('il2cpp_assembly_get_image', 'pointer', ['pointer']);
    F.image_get_name = P('il2cpp_image_get_name', 'pointer', ['pointer']);
    F.class_from_name = P('il2cpp_class_from_name', 'pointer', ['pointer', 'pointer', 'pointer']);
    F.class_get_method_from_name = P('il2cpp_class_get_method_from_name', 'pointer', ['pointer', 'pointer', 'int']);
    F.runtime_invoke = P('il2cpp_runtime_invoke', 'pointer', ['pointer', 'pointer', 'pointer', 'pointer']);
    F.object_unbox = P('il2cpp_object_unbox', 'pointer', ['pointer']);
    F.class_get_methods = P('il2cpp_class_get_methods', 'pointer', ['pointer', 'pointer']);
    F.method_get_name = P('il2cpp_method_get_name', 'pointer', ['pointer']);
    return !!(F.domain_get && F.class_from_name && F.class_get_method_from_name && F.runtime_invoke);
}

function setup() {
    const d = F.domain_get();
    F.thread_attach(d);
    const cnt = Memory.alloc(8);
    const asms = F.domain_get_assemblies(d, cnt);
    const n = cnt.readU64().toNumber();
    images = [];
    for (let i = 0; i < n; i++) {
        images.push(F.assembly_get_image(asms.add(i * 8).readPointer()));
    }
    return images.length > 0;
}

function klass(ns, name) {
    for (const img of images) {
        const k = F.class_from_name(img, Memory.allocUtf8String(ns), Memory.allocUtf8String(name));
        if (k && !k.isNull()) return k;
    }
    return null;
}

function method(ns, cls, name, argc) {
    const k = klass(ns, cls);
    if (!k) return null;
    const m = F.class_get_method_from_name(k, Memory.allocUtf8String(name), (argc === undefined ? -1 : argc));
    return (m && !m.isNull()) ? m : null;
}

function mp(mi) { return mi.add(0).readPointer(); }          // MethodInfo* -> code
function str(p) {
    try {
        if (!p || p.isNull()) return 'null';
        const len = p.add(0x10).readS32();
        if (len < 0 || len > 8192) return '<len ' + len + '>';
        return p.add(0x14).readUtf16String(len);
    } catch (e) { return '<unreadable>'; }
}

function hookFn(ns, cls, name, argc, detail) {
    const mi = method(ns, cls, name, argc);
    if (!mi) { send({ tag: 'MISSING', fn: cls + '::' + name }); return null; }
    Interceptor.attach(mp(mi), {
        onEnter(a) { this.a = a; },
        onLeave(r) {
            const rec = { tag: 'CALL', fn: cls + '::' + name };
            if (detail) detail.call(this, r, rec);
            send(rec);
        }
    });
    send({ tag: 'hooked', fn: cls + '::' + name, at: mp(mi).toString() });
    return mi;
}

function methodName(mi) { return F.method_get_name(mi).readCString(); }

// hook every method of a class (used for the obfuscated cheat action tables)
function hookAll(cls, opts) {
    opts = opts || {};
    const k = klass('', cls);
    if (!k) { send({ tag: 'MISSING', fn: cls + ' (class)' }); return; }
    const iter = Memory.alloc(8);
    iter.writePointer(ptr(0));
    let n = 0, fails = 0;
    let mi;
    while (true) {
        try {
            mi = F.class_get_methods(k, iter);
        } catch (e) { send({ tag: 'err', where: 'hookAll:' + cls, msg: String(e) }); break; }
        if (!mi || mi.isNull()) break;
        let nm = '?';
        try { nm = methodName(mi); } catch (e) { }
        const code = mp(mi);
        if (code.isNull()) continue;
        n++;
        try {
            Interceptor.attach(code, {
                onEnter(a) {
                    const rec = { tag: 'CALL', fn: cls + '::' + nm };
                    if (opts.strings) {
                        rec.in = str(a[0]);
                        rec.n1 = a[1].toInt32();
                        rec.n2 = a[2].toInt32();
                    } else if (opts.args) {
                        for (let i = 1; i <= opts.args; i++) rec['a' + i] = a[i].toString();
                    }
                    this.rec = rec;
                },
                onLeave(r) {
                    const rec = this.rec;
                    if (opts.strings) { rec.retStr = str(r); rec.retInt = r.toInt32(); }
                    else if (opts.args) { rec.ret = r.toString(); }
                    send(rec);
                }
            });
        } catch (e) {
            fails++;
            send({ tag: 'err', where: cls + '::' + nm, msg: String(e) });
        }
    }
    send({ tag: 'hooked-all', fn: cls, count: n, fails: fails });
}

function install() {
    hookFn('', 'OptionsStatic', 'GetCheatTier', 0, function (r, rec) { rec.ret = r.toInt32(); });
    hookFn('', 'OptionsStatic', 'ClearCheatCode', 0);
    hookFn('', 'OptionsStatic', 'get_AnyCheatsEnabled', 0, function (r, rec) { rec.ret = r.toInt32(); });
    hookFn('', 'OptionsStatic', 'get_DebugEnabled', 0, function (r, rec) { rec.ret = r.toInt32(); });

    hookFn('', 'Sheep', 'CheckIfSheepIsHappy', 3, function (r, rec) {
        rec.code = str(this.a[0]);
        rec.ret = r.toInt32();
        try {
            rec.status1 = this.a[1].readS32();
            rec.status2 = this.a[2].readS32();
        } catch (e) { }
    });
    hookFn('', 'Sheep', 'GetCheatCodeGuide', 0);
    hookFn('', 'Sheep', 'InputCheatCodeButtonClicked', 0);

    for (const m of ['RoomCheatsButtonClicked', 'OtherCheatsClicked', 'CumCheatsClicked'])
        hookFn('', 'RoomSheep', m);
    for (const m of ['ItemStatsCheatsButtonClicked', 'ChangeFishWeightPopup', 'ItemQualityPopup'])
        hookFn('', 'ItemStatsSheep', m);
    hookFn('', 'CheatWebsite', 'GetMoney');
    hookFn('', 'CheatWebsite', 'Open');
    for (const m of ['Open', 'UpdateCheatStatus', 'UpdateCheatDescription', 'DisableCheatsButtonClicked'])
        hookFn('', 'CheatsPopup', m);
    hookFn('', 'MenuStaticGui', 'CheatsButtonClicked');
    hookFn('', 'UiOverlay', 'OpenCheatsPopup');
    hookFn('', 'UiOverlay', 'OpenAddItemCheat');

    // money / state effects: proof of whether a cheat actually applied
    hookFn('', 'GameVariables', 'AddMoney', 1, function (r, rec) { rec.amount = this.a[1].toInt32(); });
    hookFn('', 'GameVariables', 'TryTakeMoney', 1, function (r, rec) { rec.amount = this.a[1].toInt32(); rec.ret = r.toInt32(); });
    hookFn('', 'GameVariables', 'ForceTakeMoney', 1, function (r, rec) { rec.amount = this.a[1].toInt32(); rec.ret = r.toInt32(); });
    hookFn('', 'GameVariables', 'MarkAsCheater', 0);
    hookFn('', 'PopupChoice', '.ctor');

    // every Sheep::* (the cheat action table) - name only
    hookAll('Sheep', { args: 2 });
    // the string helper used all over the cheat UI: log in/out strings
    hookAll('DUPADUPADUPADUPADUPA', { strings: true });
    // the obfuscated cheat-code parser/decryptor
    hookAll('i5H9vumTspv4LW1N6iEEGc31DdkPlaLlf2YSpdPziW97o', { strings: true });

    // THE decision point: the cheat handlers compare the stored cheat code with a prefix
    const sw = method('System', 'String', 'StartsWith', 1);
    if (sw) {
        Interceptor.attach(mp(sw), {
            onEnter(a) { this.me = str(a[0]); this.prefix = str(a[1]); },
            onLeave(r) {
                send({ tag: 'STRING.StartsWith', text: this.me, prefix: this.prefix,
                       result: r.toInt32(), low: r.toInt32() & 1 });
            }
        });
        send({ tag: 'hooked', fn: 'String::StartsWith' });
    } else {
        send({ tag: 'MISSING', fn: 'System.String::StartsWith' });
    }
    // reflection lookups by name
    const gm = method('System', 'Type', 'GetMethod', -1);
    if (gm) {
        Interceptor.attach(mp(gm), {
            onEnter(a) { send({ tag: 'reflect.GetMethod', on: str(a[0]), name: str(a[1]), arg2: a[2].toString() }); }
        });
        send({ tag: 'hooked', fn: 'Type::GetMethod' });
    }

    // what the cheat menu calls by reflection
    const inv = method('System.Reflection', 'MethodBase', 'Invoke', 2);
    if (inv) {
        Interceptor.attach(mp(inv), {
            onEnter(a) { this.mi = a[0]; },
            onLeave() {
                let nm = '?';
                try { nm = this.mi.add(0x18).readPointer().readCString(); } catch (e) { }
                send({ tag: 'CALL', fn: 'reflect-invoke', method: nm });
            }
        });
        send({ tag: 'hooked', fn: 'MethodBase::Invoke(reflect)' });
    }
}

function probe() {
    const mi = method('', 'OptionsStatic', 'GetCheatTier', 0);
    if (!mi) { send({ tag: 'probe', msg: 'GetCheatTier not found' }); return; }
    const exc = Memory.alloc(8);
    exc.writePointer(ptr(0));
    const r = F.runtime_invoke(mi, ptr(0), ptr(0), exc);
    if (exc.readPointer().isNull() && r && !r.isNull()) {
        send({ tag: 'probe', msg: 'live OptionsStatic.GetCheatTier() = ' + F.object_unbox(r).readS32() });
    } else {
        send({ tag: 'probe', msg: 'GetCheatTier threw (exception set)' });
    }
}

let ticks = 0;
const iv = setInterval(() => {
    if (started) { clearInterval(iv); return; }
    ticks++;
    try {
        mod();
        if (!bindFns()) return;
        if (!setup()) return;                 // assembly table not ready yet
        started = true;
        clearInterval(iv);
        send({ tag: 'init', msg: 'IL2CPP image resolved after ' + ticks + 's' });
        try { install(); } catch (e) { send({ tag: 'err', where: 'install', msg: String(e) + ' | ' + e.stack }); }
        try { probe(); } catch (e) { send({ tag: 'err', where: 'probe', msg: String(e) }); }
        send({ tag: 'ready', msg: 'click the cheat buttons now' });
    } catch (e) {
        send({ tag: 'retry', msg: String(e) + ' | ' + e.stack });
    }
}, 1000);
