/** The login anomaly classifier: known-good is quiet, anomalies fire. */
import { Watchdog } from "../js/watchdog.js";
let f = 0; const ok=(n)=>console.log(`ok  ${n}`); const bad=(n,e="")=>{f++;console.error(`FAIL ${n} ${e}`)};
const a=(n,c,e)=>c?ok(n):bad(n,e);
const T0 = 1_700_000_000_000; // fixed base time (afternoon UTC-ish)
const noon = T0 + 12*3600_000;

const wd = new Watchdog();
wd.seed({ fingerprints: ["known-fp"], subnets: ["192.168.1"] });

// A known device from a known network at a normal hour: not suspicious.
const normal = wd.classify({ actor:"a", fingerprint:"known-fp", ip:"192.168.1.5", memberId:"m1" }, noon);
a("known device is calm", !normal.suspicious, `score ${normal.score.toFixed(2)}`);

// A brand-new device from a new network: suspicious.
const stranger = wd.classify({ actor:"z", fingerprint:"new-fp", ip:"5.6.7.8", memberId:null }, noon);
a("unknown device + new network flags", stranger.suspicious, `score ${stranger.score.toFixed(2)}`);
a("gives human reasons", stranger.reasons.length >= 2);

// Off-hours adds suspicion.
const night = T0 + 3*3600_000;
const lateStranger = wd.classify({ actor:"z", fingerprint:"new-fp2", ip:"9.9.9.9" }, night);
a("night-time unknown scores higher than daytime", lateStranger.score > stranger.score);

// observe() learns from CALM sightings: a device seeded as known folds into
// normal and stays calm. A device that starts suspicious does NOT auto-calm —
// that is deliberate, so the classifier can never be trained to accept an
// intruder just because it connected twice; the Chair must vouch for it.
const w2 = new Watchdog();
w2.seed({ fingerprints:["fp-a"], subnets:["10.0.0"] });
const ev = { actor:"a", fingerprint:"fp-a", ip:"10.0.0.5", memberId:"m1" };
const first = w2.observe(ev, noon);
const second = w2.observe(ev, noon+1000);
a("a seeded-known device is calm on first sight", !first.suspicious);
a("and stays calm on repeat", !second.suspicious);

// A device that starts suspicious stays flagged until the Chair vouches.
const w2b = new Watchdog();
const s1 = w2b.observe({ actor:"z", fingerprint:"nf", ip:"6.6.6.6" }, noon);
const s2 = w2b.observe({ actor:"z", fingerprint:"nf", ip:"6.6.6.6" }, noon+1000);
a("a suspicious device is not auto-forgiven by reconnecting", s1.suspicious && s2.suspicious);

// The learning hook moves the threshold.
const w3 = new Watchdog();
const t0 = w3.threshold;
w3.update({ fingerprint:"x", ip:"1.1.1.1" }, "fine");
a("marking fine raises the bar", w3.threshold > t0);
w3.update({ fingerprint:"y", ip:"2.2.2.2" }, "bad");
a("marking bad lowers the bar", w3.threshold < t0 + 0.02);

// Determinism: same input, same output.
const w4 = new Watchdog();
const c1 = w4.classify({ actor:"a", fingerprint:"f", ip:"3.3.3.3" }, noon);
const c2 = w4.classify({ actor:"a", fingerprint:"f", ip:"3.3.3.3" }, noon);
a("classifier is deterministic", c1.score === c2.score);

console.log(f?`\n${f} FAILURES`:"\nwatchdog: anomaly scoring, learning, and determinism hold");
process.exit(f?1:0);
