import { describe, expect, it } from 'vitest';
import { createPalace } from '@worldsim/scenarios';
import type { PlayerInput } from '@worldsim/shared';
import { adjudicate } from './actions';

describe('语义指令只通过世界权限裁决', () => {
  it('物品、移动和拘押按 ID 裁决；错误 ID 不回退到印玺名称或角色别名', () => {
    const world = createPalace('interpreted-refs');
    const item: PlayerInput = {intent:{kind:'use'}, object:{kind:'use',object:'seal',inspection:'look'}};
    const checkItem = (object:string) => adjudicate(world,'Inspect the metalwork.',item.intent,
      {...item, object:{kind:'use',object,inspection:'look'}}, {});
    expect(checkItem('seal').itemId).toBe('seal');
    expect(checkItem('seal').candidates[0].lines[0].text).toContain('印面');
    expect(checkItem('王室印玺').candidates[0].status).toBe('refused');
    const move = (target:string) => adjudicate(world,'Double back through the courtyard.',{kind:'move'},
      {intent:{kind:'move'}, movement:{kind:'destination',target}}, {}).candidates[0];
    expect(move('gate').changes).toEqual([{op:'move',actor:'king',to:'gate'}]);
    expect(move('宫门').status).toBe('refused');
    expect(move('unknown').status).toBe('refused');
    const arrest = (object:string) => adjudicate(world,'Place him in custody.',{kind:'arrest'},
      {intent:{kind:'arrest'}, object:{kind:'arrest',object}}, {}).candidates[0];
    expect(arrest('captain').lines[0].text).toContain('凭据');
    expect(arrest('罗兰').lines[0].text).toContain('在场');
  });

  it('公开问话、耳语、礼貌及缺席听者按计划而不是措词区分', () => {
    const world = createPalace('interpreted-hearing');
    const speak = (privateLine:boolean, targetId?:string) => adjudicate(world,'Kindly remain discreet.',{kind:'speak'},
      {intent:{kind:'speak'},dialogue:{text:'Kindly remain discreet.'}},
      {speech:{private:privateLine,courteous:true,targetId}});
    const quiet = speak(true,'captain');
    expect(quiet.speech).toEqual({private:true,privateTo:'captain'});
    expect(quiet.candidates[0].changes).toEqual([{op:'relation',actor:'captain',other:'king',delta:1}]);
    expect(speak(false).speech).toEqual({private:false});
    expect(speak(false, 'minister').dialogue).toBeUndefined();
    expect(speak(false, 'minister').speech).toEqual({private:false});
    expect(speak(true, 'minister').speech).toBeUndefined();
    expect(speak(true).candidates[0].status).toBe('refused');
  });

  it('命令只把指定剧本规则交给授权且在场的 NPC，保留 NPC 是否照办的选择', () => {
    const world = createPalace('interpreted-orders');
    const rule = {id:'hang-banners', npcId:'steward', keywords:['会旗'], flag:'bannersReady', summary:'在议事厅挂起会旗'};
    world.rules.orders.push(rule);
    world.variables.bannersReady = false;
    const order = (targetId:string, flag:string) => adjudicate(world,'Make it so.',{kind:'order'},undefined,
      {order:{targetId,private:true,order:{...rule,flag}}});
    const result = order('steward','bannersReady');
    expect(result.speech).toEqual({private:true,privateTo:'steward'});
    expect(result.dialogue?.order).toEqual({summary:rule.summary,changes:[{op:'flag',name:'bannersReady',value:true}]});
    expect(result.candidates[0].changes).toEqual([]);
    expect(order('steward','outcome').dialogue?.order).toBeUndefined();
    expect(order('captain','bannersReady').dialogue?.order).toBeUndefined();
    expect(order('scribe','bannersReady').candidates[0].status).toBe('refused');
    world.characters.find(c=>c.id==='king')!.abilities = [];
    expect(order('steward','bannersReady').dialogue?.order).toBeUndefined();
  });

  it('自由调查仅由绑定的本地线索或当前房间检查发现可知事实', () => {
    const world = createPalace('interpreted-discoveries');
    world.characters.find(c=>c.id==='king')!.locationId='archive';
    const rule = world.rules.discoveries[0];
    const inspect = (object:string, selected?:typeof rule) => adjudicate(world,'Trace that entry.',{kind:'investigate'},
      {intent:{kind:'investigate'},object:{kind:'investigate',object}}, {discovery:selected}).candidates[0];
    expect(inspect('room').changes).toEqual([{op:'learn',actor:'king',fact:'ledger'}]);
    expect(inspect('paperwork',rule).changes).toEqual([{op:'learn',actor:'king',fact:'ledger'}]);
    expect(inspect('登记簿').changes).toEqual([]);
    expect(inspect('paperwork',{...rule,locationId:'gate'}).changes).toEqual([]);
    world.facts.find(f=>f.id===rule.factId)!.createdAt = world.time+1;
    expect(inspect('room').changes).toEqual([]);
  });

  it('开放行动候选、时间与展示仅采用明确计划的 activity', () => {
    const world = createPalace('interpreted-activities');
    const attempt = (activity:'listen'|'perform'|'general') =>
      adjudicate(world,'不看过去，专注于现在。',{kind:'attempt'},undefined,{activity}).candidates[0];
    expect(attempt('listen').id).toBe('listen-room');
    expect(attempt('perform').id).toBe('voice');
    expect(attempt('general').id).toBe('partial');
    expect(adjudicate(world,'我说“等等”',{kind:'look'},undefined,{}).candidates[0].id).toBe('observe');
  });
});
