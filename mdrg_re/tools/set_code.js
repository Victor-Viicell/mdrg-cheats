// Writes a synthetic cheat code into the game's PlayerPrefs (CKey) at runtime.
// Usage: loaded together with hook_cheats.js - the probe sets the code, then you click.
// frida -f <game> -l hook_cheats.js -l set_code.js   (CODE env var / --set-code)

const MODULE = 'GameAssembly.so';
const CODE = typeof CHEAT_CODE !== 'undefined' ? CHEAT_CODE : 'A~';

let F = {}, images = [];

function mod() { return Process.getModuleByName(MODULE); }
function exp(n) { return mod().getExportByName(n); }

function bind() {
    const P = (n, ret, args) => { try { return new NativeFunction(exp(n), ret, args); } catch (e) { return null; } };
    F.domain_get = P('il2cpp_domain_get', 'pointer', []);
    F.thread_attach = P('il2cpp_thread_attach', 'pointer', ['pointer']);
    F.domain_get_assemblies = P('il2cpp_domain_get_assemblies', 'pointer', ['pointer', 'pointer']);
    F.assembly_get_image = P('il2cpp_assembly_get_image', 'pointer', ['pointer']);
    F.class_from_name = P('il2cpp_class_from_name', 'pointer', ['pointer', 'pointer', 'pointer']);
    F.class_get_method_from_name = P('il2cpp_class_get_method_from_name', 'pointer', ['pointer', 'pointer', 'int']);
    F.class_get_field_from_name = P('il2cpp_class_get_field_from_name', 'pointer', ['pointer', 'pointer']);
    F.field_static_get_value = P('il2cpp_field_static_get_value', 'void', ['pointer', 'pointer']);
    F.runtime_invoke = P('il2cpp_runtime_invoke', 'pointer', ['pointer', 'pointer', 'pointer', 'pointer']);
    F.string_new = P('il2cpp_string_new', 'pointer', ['pointer']);
    return !!(F.domain_get && F.class_from_name && F.runtime_invoke);
}

function setup() {
    const d = F.domain_get();
    F.thread_attach(d);
    const cnt = Memory.alloc(8);
    const asms = F.domain_get_assemblies(d, cnt);
    const n = cnt.readU64().toNumber();
    images = [];
    for (let i = 0; i < n; i++) images.push(F.assembly_get_image(asms.add(i * 8).readPointer()));
    return images.length > 0;
}

function klass(ns, name) {
    for (const img of images) {
        const k = F.class_from_name(img, Memory.allocUtf8String(ns), Memory.allocUtf8String(name));
        if (k && !k.isNull()) return k;
    }
    return null;
}

function setCode() {
    const k = klass('', 'OptionsStatic');
    if (!k) { send({ tag: 'setcode', msg: 'OptionsStatic not found' }); return; }
    const field = F.class_get_field_from_name(k, Memory.allocUtf8String('CKeyPref'));
    if (!field || field.isNull()) { send({ tag: 'setcode', msg: 'CKeyPref field not found' }); return; }
    const holder = Memory.alloc(8);
    F.field_static_get_value(field, holder);
    const pref = holder.readPointer();
    send({ tag: 'setcode', msg: 'CKeyPref object = ' + pref });

    const s = F.string_new(Memory.allocUtf8String(CODE));
    // proper path: PlayerPrefsSimpleKey<T>::SetValue(T)
    let done = false;
    for (const cls of ['PlayerPrefsStringKey', 'PlayerPrefsSimpleKey']) {
        const pk = klass('', cls);
        if (!pk) continue;
        const m = F.class_get_method_from_name(pk, Memory.allocUtf8String('SetValue'), 1);
        if (!m || m.isNull()) continue;
        const argv = Memory.alloc(8);
        argv.writePointer(s);
        const exc = Memory.alloc(8);
        exc.writePointer(ptr(0));
        F.runtime_invoke(m, pref, argv, exc);
        send({ tag: 'setcode', msg: 'SetValue(' + cls + ') -> ' + CODE + ' exc=' + exc.readPointer() });
        done = true;
        break;
    }
    if (!done) {
        // fallback: poke the cached value (hasValue byte at +0x28, string at +0x30)
        pref.add(0x30).writePointer(s);
        pref.add(0x28).writeU8(1);
        send({ tag: 'setcode', msg: 'poked cached value at +0x30 -> ' + CODE });
    }
}

let ticks = 0;
let ready = false;
function readyLoop(cb) {
    let t = 0;
    const iv = setInterval(() => {
        t++;
        try {
            mod();
            if (!bind() || !setup()) return;
        } catch (e) { return; }
        clearInterval(iv);
        cb();
    }, 500);
}

readyLoop(() => {
    // the static field may not exist yet: keep (re)setting the code for the first minutes
    let n = 0;
    const iv = setInterval(() => {
        n++;
        try { setCode(); } catch (e) { send({ tag: 'setcode', msg: 'err ' + e }); }
        if (n >= 40) clearInterval(iv);
    }, 5000);
});
