import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { existsSync, linkSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readVolumeMarker } from "../tools/storage-compose.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const enabled = process.env.MOVIE_HARBOR_RUN_DOCKER_INTEGRATION === "1";
const marker = ".movie-harbor-volume.json";
const state = "/deployment/.movie-harbor-storage-state.json";
const media = "/deployment/old disk $literal";
const docker = (args, input) => spawnSync("docker", args, { encoding: "utf8", input, timeout: 60_000 });
function ok(result, label) {
  assert.equal(result.status, 0, `${label}\n${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
  return result.stdout;
}
function run(args, input) {
  return new Promise((resolve) => {
    const child = spawn("docker", args);
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("final marker verification refuses a shared inode or oversized marker", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mh-upgrade-marker-"));
  try {
    const markerFile = path.join(directory, marker);
    writeFileSync(markerFile, '{"version":1,"volume":0}');
    linkSync(markerFile, path.join(directory, "foreign-link"));
    assert.throws(() => readVolumeMarker(directory, 0), /valid identity marker/);
    rmSync(path.join(directory, "foreign-link"));
    writeFileSync(markerFile, ' '.repeat(4097) + '{"version":1,"volume":0}');
    assert.throws(() => readVolumeMarker(directory, 0), /valid identity marker/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("upgrade rejects absent confirmation, multiple roots and invalid registration without touching media", () => {
  // Removing authorization/state validation would create registration or touch
  // a marker, while the unavailable Docker boundary makes accidental calls fail.
  for (const variant of ["confirmation", "multiple", "normal", "broken", "path-mismatch", "root-symlink"]) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "mh-upgrade-reject-"));
    try {
      const zero = path.join(directory, "zero");
      const one = path.join(directory, "one");
      mkdirSync(zero); mkdirSync(one);
      if (variant === "root-symlink") symlinkSync(zero, path.join(directory, "linked"));
      const target = variant === "root-symlink" ? path.join(directory, "linked/") : zero;
      const env = path.join(directory, ".env");
      const stateFile = path.join(directory, ".movie-harbor-storage-state.json");
      writeFileSync(env, `MEDIA_HOST_DIR=${target}${variant === "multiple" ? `;${one}` : ""}\n`);
      if (variant === "normal") writeFileSync(stateFile, JSON.stringify({ version: 1, directories: [zero] }));
      if (variant === "broken") writeFileSync(stateFile, "{damaged");
      if (variant === "path-mismatch") writeFileSync(stateFile, JSON.stringify({ version: 1, directories: [one], upgrade: { kind: "legacy-volume-zero", id: "0123456789abcdef0123456789abcdef", device: String(lstatSync(one).dev), inode: String(lstatSync(one).ino), markerAllowed: false } }));
      const original = existsSync(stateFile) ? readFileSync(stateFile, "utf8") : null;
      const result = spawnSync("sh", ["tools/upgrade-media-storage.sh", ...(variant === "confirmation" ? [] : ["--confirm-existing-volume-zero"])], {
        cwd: root, encoding: "utf8", env: { ...process.env, MOVIE_HARBOR_ENV_FILE: env },
      });
      assert.notEqual(result.status, 0, variant);
      assert.doesNotMatch(result.stderr, /cannot open|No such file|MODULE_NOT_FOUND/, "must reject through the actual upgrade implementation");
      assert.equal(existsSync(path.join(zero, marker)), false);
      assert.equal(existsSync(stateFile) ? readFileSync(stateFile, "utf8") : null, original);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test("a rejected container protocol cannot authorize later buffered data or hang on ignored termination", () => {
  // The Docker client is the external boundary here. This catches accepting a
  // buffered READY after failure and waiting forever for a SIGTERM-ignoring peer.
  const directory = mkdtempSync(path.join(os.tmpdir(), "mh-upgrade-protocol-"));
  try {
    const media = path.join(directory, "media");
    mkdirSync(media);mkdirSync(path.join(media, "video"));
    const bin = path.join(directory, "bin");mkdirSync(bin);
    writeFileSync(path.join(bin, "docker"), '#!/usr/bin/env node\nprocess.on("SIGTERM",()=>{});process.stdout.write("INVALID\\nREADY\\t-\\n");setTimeout(()=>process.exit(0),5000);\n', {mode:0o755});
    const env = path.join(directory, ".env");writeFileSync(env, `MEDIA_HOST_DIR=${media}\n`);
    const before = Date.now();
    const result = spawnSync("sh", ["tools/upgrade-media-storage.sh", "--confirm-existing-volume-zero"], {
      cwd: root, encoding: "utf8", timeout: 10_000,
      env: {...process.env, PATH:`${bin}:${process.env.PATH}`, MOVIE_HARBOR_ENV_FILE:env},
    });
    assert.notEqual(result.status, 0);
    const pending = JSON.parse(readFileSync(path.join(directory, ".movie-harbor-storage-state.json"), "utf8"));
    assert.equal(pending.upgrade.markerAllowed, false, "failure must fence later buffered READY");
    assert.ok(Date.now()-before < 3000, "uncooperative Docker client must be forcibly terminated");
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test("explicit legacy upgrade preserves private files across real Linux UIDs and interruption", { skip: !enabled, timeout: 180_000 }, async (t) => {
  // Catches a missing upgrade entry, registration after marker, recursive chmod,
  // unsafe retries, literal path expansion and ordinary startup repairing pending.
  const volume = `mh-upgrade-${randomUUID()}`;
  ok(docker(["volume", "create", volume]), "create this test's Linux filesystem");
  const mountpoint = JSON.parse(ok(docker(["volume", "inspect", volume]), "inspect isolated volume"))[0].Mountpoint;
  const nodeArgs = (uid) => ["run", "--rm", "-i", "--user", `${uid}:${uid}`,
    "--mount", `type=bind,src=${root},dst=/project,readonly`,
    "--mount", `type=volume,src=${volume},dst=/deployment`,
    "--workdir", "/project", "node:24-alpine", "node", "--input-type=module", "-"];
  const node = (uid, source) => docker(nodeArgs(uid), source);
  let cut = "", composeCalls = 0;
  const bridgeKey = randomUUID();
  // A transport shim forwards the CLI argv to the real host Docker client.
  // The deployer remains UID 1000 on Linux; only app startup is a cheap boundary
  // stand-in. Every upgrade container is really alpine:3.22 running as root.
  const bridge = createServer((socket) => {
    let child;
    const lines = createInterface({ input: socket });
    const send = (value) => socket.write(`${JSON.stringify(value)}\n`);
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.args) {
        if (message.key !== bridgeKey) { socket.destroy(); return; }
        const args = message.args;
        if (args[0] === "compose") { composeCalls++; send({ exit: 0 }); return; }
        assert.equal(args[0], "run");
        assert.ok(args.includes("alpine:3.22"));
        const pending = JSON.parse(ok(node(1000, `import { readFileSync } from "node:fs"; console.log(readFileSync(${JSON.stringify(state)}, "utf8"));`), "read pending before privileged Docker"));
        assert.equal(pending.upgrade?.kind, "legacy-volume-zero");
        if (cut === "before-marker") { send({ exit: 91 }); return; }
        const actual = args.map((arg) => arg.startsWith('type=bind,"src=/deployment')
          ? arg.replace("src=/deployment", `src=${mountpoint}`) : arg);
        child = spawn("docker", actual);
        child.stdout.on("data", (chunk) => send({ stdout: chunk.toString("base64") }));
        child.stderr.on("data", (chunk) => send({ stderr: chunk.toString("base64") }));
        child.on("close", (code) => send({ exit: cut === "after-marker" && code === 0 ? 92 : code }));
      } else if (message.stdin) child?.stdin.write(Buffer.from(message.stdin, "base64"));
      else if (message.end) child?.stdin.end();
    });
    socket.on("close", () => child?.stdin.end());
  });
  await new Promise((resolve) => bridge.listen(0, "0.0.0.0", resolve));
  const port = bridge.address().port;
  const shim = `#!/usr/local/bin/node
const net = require("node:net");
const readline = require("node:readline");
const socket = net.connect(${port}, "host.docker.internal");
const send = value => socket.write(JSON.stringify(value) + "\\n");
socket.on("connect", () => send({key:${JSON.stringify(bridgeKey)},args: process.argv.slice(2)}));
readline.createInterface({input:socket}).on("line", line => {
 const value = JSON.parse(line);
 if(value.stdout) process.stdout.write(Buffer.from(value.stdout,"base64"));
 if(value.stderr) process.stderr.write(Buffer.from(value.stderr,"base64"));
 if(value.exit !== undefined) process.exit(value.exit ?? 1);
});
process.stdin.on("data", chunk => send({stdin:chunk.toString("base64")}));
process.stdin.on("end", () => send({end:true}));
`;
  const cli = async (script, args = []) => run(nodeArgs(1000), `
    import { spawnSync } from "node:child_process";
    const result = spawnSync("sh", [${JSON.stringify(script)}, ...${JSON.stringify(args)}], {encoding:"utf8", env:{...process.env,
      PATH:"/deployment/bin:"+process.env.PATH, MOVIE_HARBOR_ENV_FILE:"/deployment/config.env",
      MOVIE_HARBOR_STORAGE_COMPOSE_OUTPUT:"/deployment/compose.storage.generated.json"}});
    process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status ?? 1);
  `);
  const snapshot = () => JSON.parse(ok(node(0, `
    import { statSync, readFileSync } from "node:fs";
    const root=${JSON.stringify(media)};
    const paths=["video/ab/old.mp4", ".incoming", ".quarantine", ".operations", ".incoming/keep", ".quarantine/keep", ".operations/keep"];
    console.log(JSON.stringify(paths.map(name => {const p=root+"/"+name,s=statSync(p,{bigint:true});return {
      inode:String(s.ino),mtime:String(s.mtimeNs),mode:Number(s.mode&0o777n),uid:Number(s.uid),gid:Number(s.gid),
      content:s.isFile()?readFileSync(p,"utf8"):null};})));
  `), "read actual Linux media metadata"));
  try {
    ok(node(0, `
      import { mkdirSync, chmodSync, chownSync, writeFileSync } from "node:fs";
      const root=${JSON.stringify(media)};
      chownSync("/deployment",1000,1000); chmodSync("/deployment",0o755);
      mkdirSync("/deployment/bin");writeFileSync("/deployment/bin/docker",${JSON.stringify(shim)},{mode:0o755});
      writeFileSync("/deployment/config.env","UNUSED=$(touch /deployment/env-was-executed)\\nMEDIA_HOST_DIR="+root+"\\n");chownSync("/deployment/config.env",1000,1000);
      for(const p of [root,root+"/video",root+"/video/ab",... [".incoming",".quarantine",".operations"].map(n=>root+"/"+n)]) {
        mkdirSync(p); chownSync(p,10001,10001);chmodSync(p,0o700);
      }
      for(const name of [".incoming",".quarantine",".operations"]) {
        writeFileSync(root+"/"+name+"/keep","private recovery evidence",{mode:0o600});chownSync(root+"/"+name+"/keep",10001,10001);
      }
      writeFileSync(root+"/video/ab/old.mp4","irreplaceable old media",{mode:0o600});chownSync(root+"/video/ab/old.mp4",10001,10001);
    `), "seed old root 10001:10001 0700 without marker");
    const before = snapshot();
    const legacy = await cli("tools/start-compose.sh");
    assert.notEqual(legacy.status, 0, "old root must reproduce the original deployment deadlock");
    assert.match(legacy.stderr, /EACCES|permission/i);
    assert.equal(composeCalls, 0);
    t.diagnostic(`Legacy RED evidence: UID 1000 start failed: ${legacy.stderr.trim()}`);

    cut = "before-marker";
    const interrupted = await cli("tools/upgrade-media-storage.sh", ["--confirm-existing-volume-zero"]);
    assert.notEqual(interrupted.status, 0);
    ok(node(1000, `import assert from "node:assert/strict"; import {readFileSync} from "node:fs";
      assert.equal(JSON.parse(readFileSync(${JSON.stringify(state)},"utf8")).upgrade.kind,"legacy-volume-zero");`), "pending must exist before any privileged action");
    assert.notEqual((await cli("tools/start-compose.sh")).status, 0);
    assert.equal(composeCalls, 0);
    cut = "after-marker";
    assert.notEqual((await cli("tools/upgrade-media-storage.sh", ["--confirm-existing-volume-zero"])).status, 0);
    ok(node(1000, `import assert from "node:assert/strict";import {readFileSync} from "node:fs";
      assert.deepEqual(JSON.parse(readFileSync(${JSON.stringify(`${media}/${marker}`)},"utf8")),{version:1,volume:0});
      assert.equal(JSON.parse(readFileSync(${JSON.stringify(state)},"utf8")).upgrade.kind,"legacy-volume-zero");`), "interruption after marker keeps pending");
    assert.notEqual((await cli("tools/start-compose.sh")).status, 0);
    cut = "";
    ok(await cli("tools/upgrade-media-storage.sh", ["--confirm-existing-volume-zero"]), "explicit retry completes registration");
    assert.deepEqual(snapshot(), before, "media inode, bytes, permissions and private directory metadata must not change");
    ok(node(1000, `import assert from "node:assert/strict";import {readFileSync,statSync,readdirSync,existsSync} from "node:fs";
      assert.deepEqual(JSON.parse(readFileSync(${JSON.stringify(state)},"utf8")),{version:1,directories:[${JSON.stringify(media)}]});
      assert.equal(statSync(${JSON.stringify(media)}).mode&0o777,0o711);
      assert.equal(statSync(${JSON.stringify(`${media}/${marker}`)}).mode&0o777,0o644);
      assert.equal(existsSync("/deployment/env-was-executed"),false,"dotenv must never execute commands");
      assert.throws(()=>readdirSync(${JSON.stringify(media)}),{code:"EACCES"});`), "ordinary UID can read marker, but cannot list volume");
    ok(await cli("tools/start-compose.sh"), "ordinary UID restarts after upgrade");
    assert.equal(composeCalls, 1);
    assert.notEqual((await cli("tools/upgrade-media-storage.sh", ["--confirm-existing-volume-zero"])).status, 0);
    assert.equal(composeCalls, 1, "upgrade must never start application services");
    t.diagnostic(`GREEN Linux UID 1000 → alpine:3.22 UID 0 → UID 1000; preserved ${JSON.stringify(before)}`);

    // A failed first adoption must not turn a lost normal registration into
    // an acceptable retry merely because the tool has now written pending.
    ok(node(1000, `import {unlinkSync} from "node:fs";unlinkSync(${JSON.stringify(state)});unlinkSync("/deployment/compose.storage.generated.json");`), "simulate missing deployment registration");
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await cli("tools/upgrade-media-storage.sh", ["--confirm-existing-volume-zero"]);
      assert.notEqual(result.status, 0, "unregistered existing marker remains rejected on repeat");
    }

    for (const variant of ["wrong-volume", "wrong-version", "extra", "invalid", "symlink", "fifo", "directory", "hardlink", "empty", "replaced-root"]) {
      ok(node(0, `
        import {writeFileSync,unlinkSync,mkdirSync,symlinkSync,linkSync,statSync,chownSync,chmodSync} from "node:fs";
        import {spawnSync} from "node:child_process";
        const target="/deployment/case-${variant}", variant=${JSON.stringify(variant)};
        mkdirSync(target);if(variant!=="empty")mkdirSync(target+"/video");
        const marker=target+"/${marker}";
        writeFileSync("/deployment/external-${variant}",'outside unchanged',{mode:0o600});
        if(variant==="symlink")symlinkSync("/deployment/external-${variant}",marker);
        else if(variant==="fifo") {if(spawnSync("mkfifo",[marker]).status!==0)throw new Error("mkfifo");}
        else if(variant==="directory")mkdirSync(marker);
        else if(variant==="hardlink")linkSync("/deployment/external-${variant}",marker);
        else if(variant!=="empty"&&variant!=="replaced-root")writeFileSync(marker, variant==="wrong-volume"?'{"version":1,"volume":1}':variant==="wrong-version"?'{"version":2,"volume":0}':variant==="extra"?'{"version":1,"volume":0,"extra":true}':'{broken');
        chownSync(target,10001,10001);chmodSync(target,0o700);
        const s=statSync(target,{bigint:true});
        writeFileSync(${JSON.stringify(state)},JSON.stringify({version:1,directories:[target],upgrade:{kind:"legacy-volume-zero",id:"0123456789abcdef0123456789abcdef",device:String(s.dev),inode:variant==="replaced-root"?"1":String(s.ino),markerAllowed:true}}));
        chownSync(${JSON.stringify(state)},1000,1000);
        writeFileSync("/deployment/config.env","MEDIA_HOST_DIR="+target+"\\n");
      `), `seed ${variant}`);
      const result = await cli("tools/upgrade-media-storage.sh", ["--confirm-existing-volume-zero"]);
      assert.notEqual(result.status, 0, variant);
      assert.match(result.stderr, variant === "empty" ? /legacy media structure/ : variant === "replaced-root" ? /matching pending/ : variant === "hardlink" ? /foreign hard links/ : variant === "invalid" ? /JSON|Unexpected|property name/ : /marker/i, `${variant} must reach its intended validation`);
      ok(node(0, `import assert from "node:assert/strict";import {readFileSync,statSync} from "node:fs";
        assert.equal(JSON.parse(readFileSync(${JSON.stringify(state)},"utf8")).upgrade.kind,"legacy-volume-zero");
        assert.equal(readFileSync("/deployment/external-${variant}","utf8"),"outside unchanged");
        assert.equal(statSync("/deployment/external-${variant}").mode&0o777,0o600);
        assert.equal(statSync("/deployment/case-${variant}").mode&0o777,0o700);`), `reject ${variant} without modifying files or root permissions`);
      assert.equal(composeCalls, 1);
    }

    for (const checkpoint of ["temporary", "linked", "permissions"]) {
      // Simulate persisted on-disk crash states, including the nlink=2 window
      // between atomic marker publication and removal of our own temp link.
      ok(node(0, `
        import {writeFileSync,mkdirSync,linkSync,statSync,chownSync,chmodSync} from "node:fs";
        const target="/deployment/resume-${checkpoint}", id="0123456789abcdef0123456789abcdef";
        mkdirSync(target);mkdirSync(target+"/.incoming");chmodSync(target+"/.incoming",0o700);
        chownSync(target,10001,10001);chmodSync(target,0o700);
        const temporary=target+"/.movie-harbor-upgrade-"+id+".tmp";
        if(${JSON.stringify(checkpoint)}==="temporary")writeFileSync(temporary,'{"version":');
        if(${JSON.stringify(checkpoint)}==="linked") {writeFileSync(temporary,'{"version":1,"volume":0}');linkSync(temporary,target+"/${marker}");}
        if(${JSON.stringify(checkpoint)}==="permissions")writeFileSync(target+"/${marker}",'{"version":1,"volume":0}',{mode:0o600});
        const s=statSync(target,{bigint:true});
        writeFileSync(${JSON.stringify(state)},JSON.stringify({version:1,directories:[target],upgrade:{kind:"legacy-volume-zero",id,device:String(s.dev),inode:String(s.ino),markerAllowed:true}}));
        chownSync(${JSON.stringify(state)},1000,1000);writeFileSync("/deployment/config.env","MEDIA_HOST_DIR="+target+"\\n");
      `), `seed interrupted ${checkpoint}`);
      ok(await cli("tools/upgrade-media-storage.sh", ["--confirm-existing-volume-zero"]), `resume ${checkpoint}`);
      ok(node(1000, `import assert from "node:assert/strict";import {readFileSync,statSync} from "node:fs";
        assert.deepEqual(JSON.parse(readFileSync(${JSON.stringify(state)},"utf8")),{version:1,directories:["/deployment/resume-${checkpoint}"]});
        assert.equal(statSync("/deployment/resume-${checkpoint}/${marker}").nlink,1);
        assert.equal(statSync("/deployment/resume-${checkpoint}/${marker}").mode&0o777,0o644);`), `verify completed ${checkpoint}`);
    }
  } finally {
    bridge.close();
    ok(docker(["volume", "rm", volume]), "remove only this test's named Linux volume");
  }
});
