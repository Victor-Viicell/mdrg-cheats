// Drives the in-game cheat entry points directly from the Unity main thread
// (managed code must not be called from frida's own thread).
//   1. writes a synthetic cheat code into PlayerPrefs.CKey
//   2. finds RoomStaticGui -> roomSheep
//   3. invokes RoomSheep::RoomCheatsButtonClicked()
// Load together with hook_cheats.js so the whole call trace is visible.
// frida -f <game> -l hook_cheats.js -l drive_cheats.js

const MODULE = 'GameAssembly.so';
const CODE = typeof CHEAT_CODE !== 'undefined' ? CHEAT_CODE : 'A~AAAAAAAAAAAAAAAAAAAAAAAA';
const EVERY_FRAMES = typeof DRIVE_EVERY_FRAMES !== 'undefined' ? DRIVE_EVERY_FRAMES : 180;

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
    F.field_get_offset = P('il2cpp_field_get_offset', 'uint', ['pointer']);
    F.class_get_type = P('il2cpp_class_get_type', 'pointer', ['pointer']);
    F.type_get_object = P('il2cpp_type_get_object', 'pointer', ['pointer']);
    F.runtime_invoke = P('il2cpp_runtime_invoke', 'pointer', ['pointer', 'pointer', 'pointer', 'pointer']);
    F.object_unbox = P('il2cpp_object_unbox', 'pointer', ['pointer']);
    F.string_new = P('il2cpp_string_new', 'pointer', ['pointer']);
    F.field_static_get_value = P('il2cpp_field_static_get_value', 'void', ['pointer', 'pointer']);
    F.method_get_name = P('il2cpp_method_get_name', 'pointer', ['pointer']);
    return !!(F.domain_get && F.runtime_invoke && F.class_get_method_from_name);
}

function setup() {
    F.thread_attach(F.domain_get());
    const cnt = Memory.alloc(8);
    const asms = F.domain_get_assemblies(F.domain_get(), cnt);
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

function invoke(mi, obj, args) {
    const exc = Memory.alloc(8);
    exc.writePointer(ptr(0));
    let argv = ptr(0);
    if (args && args.length) {
        argv = Memory.alloc(args.length * 8);
        args.forEach((a, i) => argv.add(i * 8).writePointer(a));
    }
    const r = F.runtime_invoke(mi, obj, argv, exc);
    return { ret: r, threw: !exc.readPointer().isNull() };
}

function setCode() {
    const k = klass('', 'OptionsStatic');
    if (!k) return 'no OptionsStatic';
    const field = F.class_get_field_from_name(k, Memory.allocUtf8String('CKeyPref'));
    if (!field || field.isNull()) return 'no CKeyPref';
    const holder = Memory.alloc(8);
    F.field_static_get_value(field, holder);
    const pref = holder.readPointer();
    if (pref.isNull()) return 'CKeyPref null';
    const pk = klass('', 'PlayerPrefsStringKey');
    const m = pk ? F.class_get_method_from_name(pk, Memory.allocUtf8String('SetValue'), 1) : null;
    if (!m || m.isNull()) return 'no SetValue';
    const r = invoke(m, pref, [F.string_new(Memory.allocUtf8String(CODE))]);
    return 'code=' + CODE + ' threw=' + r.threw;
}

function roomSheepInstance() {
    const guiK = klass('', 'RoomStaticGui');
    if (!guiK) return { err: 'no RoomStaticGui' };
    const uoK = klass('UnityEngine', 'Object');
    const foom = uoK ? F.class_get_method_from_name(uoK, Memory.allocUtf8String('FindObjectOfType'), 1) : null;
    if (!foom || foom.isNull()) return { err: 'no FindObjectOfType' };
    const r = invoke(foom, ptr(0), [F.type_get_object(F.class_get_type(guiK))]);
    if (r.threw) return { err: 'FindObjectOfType threw (not main thread?)' };
    if (r.ret.isNull()) return { err: 'no RoomStaticGui instance (not in the room?)' };
    const f = F.class_get_field_from_name(guiK, Memory.allocUtf8String('roomSheep'));
    if (!f || f.isNull()) return { err: 'no roomSheep field' };
    const sheep = r.ret.add(F.field_get_offset(f)).readPointer();
    return { sheep: sheep, gui: r.ret };
}

let frames = 0, drives = 0, lastMsg = '';
let SHEEP = null, GUI_THIS = null, SHEEP_OFF = null;
function tick() {                              // called from the main thread
    frames++;
    if (frames % EVERY_FRAMES !== 0) return;
    try {
        const sc = setCode();
        if (!SHEEP || SHEEP.isNull()) { send({ tag: 'drive', setcode: sc, lookup: 'no roomSheep captured yet' }); return; }
        const k = klass('', 'RoomSheep');
        const m = F.class_get_method_from_name(k, Memory.allocUtf8String('RoomCheatsButtonClicked'), 0);
        if (!m || m.isNull()) { send({ tag: 'drive', lookup: 'no RoomCheatsButtonClicked' }); return; }
        drives++;
        const r = invoke(m, SHEEP, []);
        send({ tag: 'drive', drives: drives, setcode: sc, invoked: 'RoomCheatsButtonClicked', threw: r.threw });
    } catch (e) {
        const msg = String(e);
        if (msg !== lastMsg) { lastMsg = msg; send({ tag: 'drive', err: msg }); }
    }
}

function installDriver() {
    // GameScript::Update runs every frame on the main thread - a safe place to call managed code
    const gsK = klass('', 'GameScript');
    const up = gsK ? F.class_get_method_from_name(gsK, Memory.allocUtf8String('Update'), 0) : null;
    if (!up || up.isNull()) { send({ tag: 'drive', err: 'no GameScript::Update to piggyback on' }); return; }
    Interceptor.attach(up.add(0).readPointer(), { onEnter() { tick(); } });
    send({ tag: 'drive', msg: 'driver attached to GameScript::Update, every ' + EVERY_FRAMES + ' frames' });

    // capture the RoomStaticGui instance (and its roomSheep) when the room GUI builds its buttons
    const guiK = klass('', 'RoomStaticGui');
    if (guiK) {
        const f = F.class_get_field_from_name(guiK, Memory.allocUtf8String('roomSheep'));
        SHEEP_OFF = (f && !f.isNull()) ? F.field_get_offset(f) : null;
        for (const name of ['UpdateButtons', 'OnEnable', 'Awake']) {
            const m = F.class_get_method_from_name(guiK, Memory.allocUtf8String(name), 0);
            if (!m || m.isNull()) continue;
            Interceptor.attach(m.add(0).readPointer(), {
                onEnter(a) {
                    GUI_THIS = a[0];
                    if (SHEEP_OFF !== null) {
                        const s = a[0].add(SHEEP_OFF).readPointer();
                        if (!s.isNull()) SHEEP = s;
                    }
                }
            });
            send({ tag: 'drive', msg: 'capturing RoomStaticGui::' + name });
        }
    }
}

function readyLoop(cb) {
    const iv = setInterval(() => {
        try {
            mod();
            if (!bind() || !setup()) return;
        } catch (e) { return; }
        clearInterval(iv);
        cb();
    }, 500);
}

readyLoop(() => { installDriver(); });
