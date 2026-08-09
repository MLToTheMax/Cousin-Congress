import { fold, emptyState, applyOp } from "./js/crdt.js";

const mkop = (type, payload, over={}) => ({
  actor: over.actor || "genesis",  // genesis => authorize() returns true, simulates an authorized insider write
  seq: over.seq ?? 0,
  hlc: over.hlc || "0000000000001:00000:genesis",
  type, payload, ...over,
});

// 1) id === "__proto__" through put()
let s = emptyState();
applyOp(s, mkop("member.upsert", { id: "__proto__", name: "PWN", presence: "present" }));
console.log("1a Object.prototype.name polluted?", ({}).name);
console.log("1a members proto set?", Object.getPrototypeOf(s.members)?.name);

// 2) payload carrying a literal __proto__ key (JSON.parse style own prop) spread by put()
const raw = '{"id":"m1","__proto__":{"polluted":"yes"},"name":"x"}';
const payload = JSON.parse(raw);
console.log("2 own __proto__ key present on parsed payload?", Object.prototype.hasOwnProperty.call(payload, "__proto__"));
let s2 = emptyState();
applyOp(s2, mkop("member.upsert", payload));
console.log("2 Object.prototype.polluted?", ({}).polluted);
console.log("2 member record polluted?", s2.members.m1?.polluted, "proto:", Object.getPrototypeOf(s2.members.m1)?.polluted);

// 3) constructor.prototype pollution attempt
const raw3 = '{"id":"m2","constructor":{"prototype":{"x":1}}}';
applyOp(s2, mkop("member.upsert", JSON.parse(raw3), {hlc:"0000000000002:00000:genesis", seq:1}));
console.log("3 Object.prototype.x?", ({}).x);

// 4) session.set with __proto__ key
let s4 = emptyState();
applyOp(s4, mkop("session.set", JSON.parse('{"__proto__":{"sPwn":1},"sitting":2}')));
console.log("4 Object.prototype.sPwn?", ({}).sPwn, "session proto?", Object.getPrototypeOf(s4.session)?.sPwn);

// 5) chairKeys kid = __proto__
let s5 = emptyState();
applyOp(s5, mkop("chair.claim", { kid: "__proto__" }));
console.log("5 chairKeys __proto__ own?", Object.prototype.hasOwnProperty.call(s5.session.chairKeys||{}, "__proto__"));
console.log("5 Object.prototype poisoned via chairKeys?", ({}).actor);

// 6) ballot key with __proto__ in voteId/memberId
let s6 = emptyState();
applyOp(s6, mkop("ballot.cast", { voteId:"__proto__", memberId:"__proto__", choice:"yea" }));
console.log("6 ballots proto?", Object.getPrototypeOf(s6.ballots)?.choice, "global?", ({}).choice);

console.log("DONE. Global Object.prototype keys now:", Object.keys(Object.prototype));
