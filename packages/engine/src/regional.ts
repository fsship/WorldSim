import { groupCountAt, type Character, type LLMProvider, type Observation, type WorldState } from "@worldsim/shared";
import { commitNpcAction } from "./npc-action";
import { npcTextIsPrivate } from "./npc-dialogue";
import { blockedRoute, inLocation, perceive, player, record } from "./state";

/** Ordinary populations advance by timetable. Only record the change a player
 * staying in this room could witness; distant rooms need no movement logs. */
export function observePopulation(world:WorldState, since:number, stayedHere:boolean): Observation[] {
  const king = player(world);
  if (!stayedHere || king.journey || since >= world.time) return [];
  const room = world.locations.find(l => l.id === king.locationId)!;
  const observations:Observation[] = [];
  for (const g of world.populationGroups) {
    const count = groupCountAt(g,room.id,world.time);
    const change = count - groupCountAt(g,room.id,since);
    if (!change) continue;
    const text = change > 0
      ? change + "名" + g.name + "来到" + room.name + "，眼前已有" + count + "人。"
      : -change + "名" + g.name + "离开了" + room.name + (count ? "，还有" + count + "人留在这里。" : "。");
    const witnesses = world.characters.filter(c => c.condition !== "dead" && inLocation(c,room.id)).map(c => c.id);
    const e = record(world,{source:"population",kind:"world",locationId:room.id,perception:"local",
      recipients:witnesses, noticeWitnessIds:witnesses,text,changes:[]});
    const seen = perceive(e,world);
    if (seen) observations.push({...seen,time:world.time});
  }
  return observations;
}

interface Assignment {
  actor:Character;
  place:string;
  task:string;
  destination:string;
  nextId:string;
}

/** A regional move takes one real step, including into the foreground.
 * The actor will use detailed decisions there from the next opportunity. */
function nextStep(world:WorldState, start:string, goal:string):string|undefined {
  const visited = new Set([start]);
  const queue = [{id:start,first:""}];
  for (let i=0; i<queue.length; i++) {
    const current = queue[i];
    for (const next of world.locations.find(l => l.id === current.id)?.exits ?? []) {
      if (visited.has(next) || blockedRoute(world,current.id,next,false)) continue;
      const first = current.first || next;
      if (next === goal) return first;
      visited.add(next);
      queue.push({id:next,first});
    }
  }
}

/** One high-level choice for important distant tasks, at most twice per game hour.
 * The request contains only public jobs and places, never a cast's private transcripts. */
export async function advanceRegion(world:WorldState, provider:LLMProvider, detailed:ReadonlySet<string>):Promise<Observation[]> {
  const seen:Observation[] = [];
  if (world.time % 30) return seen;
  const lastDecision = new Map<string,number>();
  const acted = new Set<string>();
  for (const e of world.history) {
    if (e.source === "regional-duty" && e.time === world.time) return seen;
    if (e.time === world.time && e.npcAction) acted.add(e.npcAction.actorId);
    if (e.npcAction?.regional) lastDecision.set(e.npcAction.actorId,e.time);
  }
  const eligible:Assignment[] = [];
  for (const actor of world.characters) {
    if (actor.kind !== "npc" || actor.condition !== "healthy" || actor.journey || detailed.has(actor.locationId) || acted.has(actor.id)) continue;
    const due = actor.appointments?.find(a => a.from <= world.time && world.time < a.until &&
      actor.locationId !== a.locationId);
    if (!due || npcTextIsPrivate(world,actor,[],due.task)) continue;
    const nextId = nextStep(world,actor.locationId,due.locationId);
    const place = world.locations.find(l => l.id === actor.locationId);
    const dest = world.locations.find(l => l.id === due.locationId);
    if (nextId && place && dest) eligible.push({actor,place:place.name,task:due.task,destination:dest.name,nextId});
  }
  const jobs = eligible.sort((a,b) => (lastDecision.get(a.actor.id) ?? -1) - (lastDecision.get(b.actor.id) ?? -1)).slice(0,2);
  if (!jobs.length) return seen;
  const choices = [
    {id:"hold", summary:"继续留守当前岗位", jobs:[] as Assignment[]},
    ...jobs.map((job,i) => ({id:"go-"+i, summary:job.actor.role+"从"+job.place+"动身前往"+job.destination+"，办理「"+job.task+"」", jobs:[job]})),
  ];
  if (jobs.length === 2) choices.push({id:"go-both",summary:"两位参与者都动身办理各自的公务",jobs});
  const options = choices.map(({id,summary}) => ({id,summary}));
  let choice;
  try {
    const result = await provider.resolve({
      text:"结算远处地区已到期的公务。",intent:{kind:"attempt"},location:"远处辖区",
      actor:{name:"辖区",role:"地区",abilities:[]},options,
      regionalDuty:{time:world.time,options,duties:jobs.map(j => ({role:j.actor.role,place:j.place,task:j.task,destination:j.destination}))},
    });
    choice = choices.find(c => c.id === result.optionId);
  } catch { /* Keep the last confirmed position until another opportunity. */ }
  record(world,{source:"regional-duty",kind:"system",locationId:jobs[0].actor.locationId,perception:"private",recipients:[],
    text:choice ? "远处地区的公务已经结算。" : "本次未能确认远处公务的进展。",changes:[]});
  if (!choice) return seen;
  for (const job of jobs) {
    const moving = choice.jobs.includes(job);
    if (moving) {
      const event = commitNpcAction(world,job.actor,{source:"provider",proposal:{kind:"move",destination:job.nextId}},
        "npc-action",undefined,"ambient");
      if (event?.npcAction) {
        event.npcAction.regional = true;
        const observation = perceive(event,world);
        if (observation) seen.push({...observation,time:world.time});
      }
    } else {
      record(world,{source:"regional-duty",kind:"system",locationId:job.actor.locationId,perception:"private",recipients:[],
        text:job.actor.name+"继续留守。",changes:[],npcAction:{actorId:job.actor.id,kind:"stay",trigger:"ambient",source:"provider",regional:true}});
    }
  }
  return seen;
}
