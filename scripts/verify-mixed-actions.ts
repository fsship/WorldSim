import assert from 'node:assert/strict';
import {prepareOpening, projectWorld, runTurn} from '../packages/engine/src';
import {createProvider} from '../packages/llm/src';
import {createCustomScenario} from '../packages/scenarios/src';
import {WorldStateSchema} from '../packages/shared/src';
import {readLiveConfig} from './live-fixture';

const provider = createProvider(readLiveConfig());
let world = await prepareOpening(createCustomScenario('commuter','cup-test',{
  worldInfo:'2026年的世界', opening:'我是普通公司职员，附近有一家咖啡店。',
  locations:[{id:'office',name:'公司',description:'我的工位上有一张办公桌。'},
    {id:'shop',name:'咖啡店',description:'柜台供应现成的热咖啡，点单即可取杯。'}],
}),provider);
async function play(input:string) {
  const result = await runTurn(WorldStateSchema.parse(JSON.parse(JSON.stringify(world))),input,provider);
  world = result.world;
  console.log(JSON.stringify({input,time:world.time,place:projectWorld(world).location.name,
    version:world.version,plan:result.turn.plan,narrative:result.turn.narrative,state:world.sceneState}));
  assert.equal(result.turn.resolution.status,'resolved');
  return result.turn;
}
await play('我去咖啡店');
await play('我点一杯咖啡');
await play('我接过刚才点的咖啡');
const cup = world.sceneState.find(entry => entry.scope === 'held');
assert.ok(cup?.objectId);
function findCup() {
  const matches = world.sceneState.filter(entry => entry.objectId === cup?.objectId);
  assert.equal(matches.length,1);
  return matches[0];
}
await play('我端起手里的那杯喝一口');
assert.equal(findCup().scope,'held');
const trip = await play('我拿着刚才那杯咖啡离开咖啡店，回到公司，把咖啡放在工位上');
assert.equal(trip.plan?.kind,'itinerary');
assert.equal(projectWorld(world).location.id,'office');
assert.equal(findCup().locationId,'office');
assert.equal(findCup().scope,'scene');
assert.match(findCup().value,/工位|办公桌|桌/);
assert.equal(projectWorld(world).player.items.length,0);
const onDesk = findCup().value;
const pickup = await play('我拿起桌上那杯喝一口');
assert.equal(findCup().scope,'held');
assert.ok(pickup.changes.some(c => c.op === 'sceneStep' && c.clears?.some(e => e.scope === 'scene' && e.value === onDesk)));
assert.deepEqual(projectWorld(world).player.items.map(i=>i.id),[cup.objectId]);
