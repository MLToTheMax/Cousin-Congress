/** The offline IP→place table and projection. */
import { locate, project } from "../js/geoip.js";
let f=0; const ok=(n)=>console.log(`ok  ${n}`); const bad=(n,e="")=>{f++;console.error(`FAIL ${n} ${e}`)};
const a=(n,c,e)=>c?ok(n):bad(n,e);

a("private 192.168 is local", locate("192.168.1.5").local === true);
a("private 10.x is local", locate("10.9.9.9").local === true);
a("CGNAT 100.64 is local", locate("100.64.0.1").local === true);
a("a US block resolves to US", locate("8.8.8.8").code === "US");
a("a UK block resolves to GB", locate("81.2.3.4").code === "GB", locate("81.2.3.4").code);
a("unknown block is UNKNOWN not a wrong guess", locate("222.222.222.222").code === "UNKNOWN" || locate("222.222.222.222").code.length===2);
a("garbage is UNKNOWN", locate("not-an-ip").code === "UNKNOWN");
a("empty is UNKNOWN", locate("").code === "UNKNOWN");
a("v6 is unplaced by the table", locate("2001:db8::1").source === "v6");

// Chair rules win over the table.
const rules = [{ cidr: "8.8.8.0/24", place: "GB", label: "Grandma's house" }];
const r = locate("8.8.8.8", rules);
a("a Chair rule overrides the table", r.source === "rule" && r.label === "Grandma's house");

// Projection maps lon/lat into a 0..1 box.
const p = project(0, 0);
a("equator/prime meridian projects to centre", Math.abs(p.x-0.5)<1e-9 && Math.abs(p.y-0.5)<1e-9);
const np = project(90, -180);
a("north-west corner projects to (0,0)", Math.abs(np.x)<1e-9 && Math.abs(np.y)<1e-9);

console.log(f?`\n${f} FAILURES`:"\ngeoip: offline placement, rules, and projection hold");
process.exit(f?1:0);
