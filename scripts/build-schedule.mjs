// Regenerates data/schedule.json from the official FIFA World Cup 2026 match
// schedule. FIFA numbers matches in chronological kickoff order (1-24 =
// Matchday 1, 25-48 = MD2, 49-72 = MD3, 73-104 = knockouts), so sorting by
// match number is the schedule. Group fixtures are mapped to our PAIR_ORDER
// storage slots via the team codes in data/tournament.json.
// Run: node scripts/build-schedule.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { GROUP_IDS, PAIR_ORDER } from "../js/core.js";

const t = JSON.parse(readFileSync(new URL("../data/tournament.json", import.meta.url)));

// [matchNo, home, away, group, time(ET)] from the FIFA schedule PDF.
const G = [
  [1,"MEX","RSA","A","15:00"],[2,"KOR","CZE","A","22:00"],[3,"CAN","BIH","B","15:00"],
  [4,"USA","PAR","D","21:00"],[5,"HAI","SCO","C","21:00"],[6,"AUS","TUR","D","00:00"],
  [7,"BRA","MAR","C","18:00"],[8,"QAT","SUI","B","15:00"],[9,"CIV","ECU","E","19:00"],
  [10,"GER","CUW","E","13:00"],[11,"NED","JPN","F","16:00"],[12,"SWE","TUN","F","22:00"],
  [13,"KSA","URU","H","18:00"],[14,"ESP","CPV","H","12:00"],[15,"IRN","NZL","G","21:00"],
  [16,"BEL","EGY","G","15:00"],[17,"FRA","SEN","I","15:00"],[18,"IRQ","NOR","I","18:00"],
  [19,"ARG","ALG","J","21:00"],[20,"AUT","JOR","J","00:00"],[21,"GHA","PAN","L","19:00"],
  [22,"ENG","CRO","L","16:00"],[23,"POR","COD","K","13:00"],[24,"UZB","COL","K","22:00"],
  [25,"CZE","RSA","A","12:00"],[26,"SUI","BIH","B","15:00"],[27,"CAN","QAT","B","18:00"],
  [28,"MEX","KOR","A","21:00"],[29,"BRA","HAI","C","20:30"],[30,"SCO","MAR","C","18:00"],
  [31,"TUR","PAR","D","23:00"],[32,"USA","AUS","D","15:00"],[33,"GER","CIV","E","16:00"],
  [34,"ECU","CUW","E","20:00"],[35,"NED","SWE","F","13:00"],[36,"TUN","JPN","F","00:00"],
  [37,"URU","CPV","H","18:00"],[38,"ESP","KSA","H","12:00"],[39,"BEL","IRN","G","15:00"],
  [40,"NZL","EGY","G","21:00"],[41,"NOR","SEN","I","20:00"],[42,"FRA","IRQ","I","17:00"],
  [43,"ARG","AUT","J","13:00"],[44,"JOR","ALG","J","23:00"],[45,"ENG","GHA","L","16:00"],
  [46,"PAN","CRO","L","19:00"],[47,"POR","UZB","K","13:00"],[48,"COL","COD","K","22:00"],
  [49,"SCO","BRA","C","18:00"],[50,"MAR","HAI","C","18:00"],[51,"SUI","CAN","B","15:00"],
  [52,"BIH","QAT","B","15:00"],[53,"CZE","MEX","A","21:00"],[54,"RSA","KOR","A","21:00"],
  [55,"CUW","CIV","E","16:00"],[56,"ECU","GER","E","16:00"],[57,"JPN","SWE","F","19:00"],
  [58,"TUN","NED","F","19:00"],[59,"TUR","USA","D","22:00"],[60,"PAR","AUS","D","22:00"],
  [61,"NOR","FRA","I","15:00"],[62,"SEN","IRQ","I","15:00"],[63,"EGY","IRN","G","23:00"],
  [64,"NZL","BEL","G","23:00"],[65,"CPV","KSA","H","20:00"],[66,"URU","ESP","H","20:00"],
  [67,"PAN","ENG","L","17:00"],[68,"CRO","GHA","L","17:00"],[69,"ALG","AUT","J","22:00"],
  [70,"JOR","ARG","J","22:00"],[71,"COL","POR","K","19:30"],[72,"COD","UZB","K","19:30"],
];

// Knockout kickoff times by match number (round/teams live in tournament.json).
const KO_TIME = {73:"15:00",74:"16:30",75:"21:00",76:"13:00",77:"17:00",78:"13:00",
  79:"21:00",80:"12:00",81:"20:00",82:"16:00",83:"19:00",84:"15:00",85:"23:00",86:"18:00",
  87:"21:30",88:"14:00",89:"17:00",90:"13:00",91:"16:00",92:"20:00",93:"15:00",94:"20:00",
  95:"12:00",96:"16:00",97:"16:00",98:"15:00",99:"17:00",100:"21:00",101:"15:00",102:"15:00",
  103:"17:00",104:"15:00"};

const idxOf = {};
for (const g of GROUP_IDS) idxOf[g] = Object.fromEntries(t.groups[g].map((tm, k) => [tm.code, k]));
const slotOf = (i, j) => PAIR_ORDER.findIndex(([x, y]) => (x === i && y === j) || (x === j && y === i));

const errors = [];
const seen = new Set();
const groupSlots = Object.fromEntries(GROUP_IDS.map((g) => [g, new Set()]));
const entries = [];

for (const [m, home, away, g, time] of G) {
  if (seen.has(m)) errors.push(`dup match ${m}`); seen.add(m);
  const i = idxOf[g]?.[home], j = idxOf[g]?.[away];
  if (i == null) errors.push(`m${m}: ${home} not in group ${g}`);
  if (j == null) errors.push(`m${m}: ${away} not in group ${g}`);
  if (i == null || j == null) continue;
  const slot = slotOf(i, j);
  if (slot < 0) errors.push(`m${m}: ${home}-${away} not a valid pair`);
  if (groupSlots[g].has(slot)) errors.push(`m${m}: group ${g} slot ${slot} repeated`);
  groupSlots[g].add(slot);
  entries.push({ m, round: "GROUP", md: Math.floor((m - 1) / 24) + 1, g, slot, time });
}
for (const g of GROUP_IDS) if (groupSlots[g].size !== 6) errors.push(`group ${g}: ${groupSlots[g].size}/6 slots`);

const koByNum = Object.fromEntries(t.knockout.map((d) => [d.m, d]));
for (let m = 73; m <= 104; m++) {
  if (!koByNum[m]) errors.push(`ko ${m} missing from tournament.json`);
  if (!KO_TIME[m]) errors.push(`ko ${m} missing time`);
  entries.push({ m, round: koByNum[m]?.r ?? "?", time: KO_TIME[m] });
}
if (entries.filter((e) => e.round === "GROUP").length !== 72) errors.push("group count != 72");

entries.sort((a, b) => a.m - b.m);
if (errors.length) { console.error("VALIDATION FAILED:\n" + errors.join("\n")); process.exit(1); }

writeFileSync(new URL("../data/schedule.json", import.meta.url), JSON.stringify(entries) + "\n");
console.log(`OK: wrote ${entries.length} matches (72 group + 32 KO), all validated.`);
