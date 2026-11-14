import { z } from 'zod';

const key = z.string().trim().min(1).max(80);
const description = z.string().trim().min(1).max(600);
const route = z.object({from:key,to:key,mode:z.enum(['all','vehicle'])}).strict()
  .refine(r=>r.from!==r.to,'路线需要两个不同的地点');
const routes = z.array(route).max(32);
const actionIds = z.array(key).max(24).refine(ids=>new Set(ids).size===ids.length,'行动标识重复');
const action = z.object({
  id:key, summary:description, locationId:key.optional(), outcome:description,
  minutes:z.number().int().min(1).max(1440), availableAfterMinutes:z.number().int().min(0).max(10080).optional(),
  next:z.object({summary:description,blockedRoutes:routes,actions:actionIds.optional(),playerGoal:description.nullable().optional()}).strict(),
}).strict();

export const situationDefinitionSchema = z.object({
  id:key,summary:description,blockedRoutes:routes,actions:z.array(action).max(24),initialActions:actionIds.optional(),
}).strict().superRefine((value,ctx)=>{
  const ids=new Set(value.actions.map(a=>a.id));
  if (ids.size!==value.actions.length) ctx.addIssue({code:'custom',path:['actions'],message:'局势行动标识重复'});
  const check=(refs:string[]|undefined,path:(string|number)[])=>{
    if (refs?.some(ref=>!ids.has(ref))) ctx.addIssue({code:'custom',path,message:'局势没有定义该行动'});
  };
  check(value.initialActions,['initialActions']);
  value.actions.forEach((a,i)=>check(a.next.actions,['actions',i,'next','actions']));
});

const instant=z.number().int().nonnegative().safe();
const decision=z.object({actionId:key,at:instant,outcome:description}).strict();
const lastReport=z.object({actorId:key,summary:description,at:instant,decisions:z.array(decision)}).strict();
export const activeSituationSchema = z.object({
  id:key,eventId:key,locationId:key,summary:description,blockedRoutes:routes,actions:z.array(action),
  startedAt:instant,updatedAt:instant,
  decisions:z.array(decision),
  lastReports:z.array(lastReport).default([]),
  witnesses:z.array(key),
}).strict();
export type ActiveSituation = z.infer<typeof activeSituationSchema>;
