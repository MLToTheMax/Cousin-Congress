/** IP moderation matcher: CIDR ranges, v4/v6, and the allow/block policy. */
import { matchAddress, addressAllowed } from "../js/netrules.js";
let f = 0; const ok = (n)=>console.log(`ok  ${n}`); const bad=(n)=>{f++;console.error(`FAIL ${n}`)};
const a=(n,c)=>c?ok(n):bad(n);

a("exact v4 match", matchAddress("192.168.1.5", "192.168.1.5"));
a("v4 /24 contains", matchAddress("192.168.1.200", "192.168.1.0/24"));
a("v4 /24 excludes", !matchAddress("192.168.2.1", "192.168.1.0/24"));
a("v4 /8 contains", matchAddress("10.55.99.1", "10.0.0.0/8"));
a("v4 /0 matches all", matchAddress("8.8.8.8", "0.0.0.0/0"));
a("v4 /32 is exact", matchAddress("1.2.3.4", "1.2.3.4/32") && !matchAddress("1.2.3.5", "1.2.3.4/32"));
a("malformed rule never matches", !matchAddress("1.2.3.4", "not-an-ip"));
a("out-of-range octet rejected", !matchAddress("1.2.3.4", "999.0.0.0/8"));
a("v6 exact", matchAddress("2001:db8::1", "2001:db8::1"));
a("v6 /32 contains", matchAddress("2001:db8:abcd::1", "2001:db8::/32"));
a("v6 /32 excludes", !matchAddress("2001:dead::1", "2001:db8::/32"));
a("v6 /48 boundary", matchAddress("2001:db8:1::1", "2001:db8:1::/48") && !matchAddress("2001:db8:2::1", "2001:db8:1::/48"));
a("families don't cross", !matchAddress("1.2.3.4", "2001:db8::/32") && !matchAddress("2001:db8::1", "1.2.3.0/24"));

// Policy
a("no rules = allow", addressAllowed([], "1.2.3.4"));
a("block wins", !addressAllowed([{action:"block",cidr:"1.2.3.0/24"}], "1.2.3.4"));
a("allow-list mode denies non-match", !addressAllowed([{action:"allow",cidr:"10.0.0.0/8"}], "1.2.3.4"));
a("allow-list mode permits match", addressAllowed([{action:"allow",cidr:"10.0.0.0/8"}], "10.1.2.3"));
a("block overrides allow", !addressAllowed([{action:"allow",cidr:"10.0.0.0/8"},{action:"block",cidr:"10.9.0.0/16"}], "10.9.1.1"));
a("per-member scope applies", !addressAllowed([{action:"block",cidr:"1.2.3.0/24",memberId:"m1"}], "1.2.3.4", "m1"));
a("per-member scope ignores others", addressAllowed([{action:"block",cidr:"1.2.3.0/24",memberId:"m1"}], "1.2.3.4", "m2"));

console.log(f?`\n${f} FAILURES`:"\nnetrules: CIDR matching and allow/block policy hold");
process.exit(f?1:0);
