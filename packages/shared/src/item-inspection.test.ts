import { describe, expect, it } from 'vitest';
import { readPlayerInput } from './player-input';

const items = ['王室印玺','印玺','王印','银钥匙'];
const read = (input:string, names:readonly string[] = items) =>
  readPlayerInput(input, ['艾琳','罗兰'], ['议事厅'], ['朝会议程','长桌'], names);

describe('拿起物品后直接观察', () => {
  it.each([
    ['我拿起王室印玺仔细看','王室印玺'],
    ['我拿起这枚印玺端详了一番。','印玺'],
    ['我拿起王印，顺手仔细端详它','王印'],
    ['我拿起银钥匙，然后看了看它','银钥匙'],
    ['我拿起一把银钥匙仔细看看', '银钥匙'],
    ['我把王室印玺拿起来看看','王室印玺'],
    ['我将手边的王印拿起，仔细看了看','王印'],
  ])('把动作尾部与实际宾语分开：%s', (input, name) => {
    expect(read(input)?.object).toEqual({kind:'use',object:name, inspection:'handle'});
  });

  it.each([
    ['我端详王室印玺','王室印玺'],
    ['我看向王印','王印'],
    ['我把王室印玺仔细端详了一番','王室印玺'],
  ])('玩家直接查看实际可检查的物品：%s', (input, name) => {
    const action = read(input);
    expect(action?.object).toEqual({kind:'use',object:name, inspection:'look'});
    expect(action?.intent).toEqual({kind:'use',item:name});
  });

  it.each([
    ['我把背包里的王印取出来仔细观察','王印','handle'],
    ['我从背包里拿出银钥匙瞧一眼','银钥匙','handle'],
    ['我从口袋里取出那枚王室印玺检视了一下','王室印玺','handle'],
    ['我把手里那枚王印拿起来端详','王印','handle'],
    ['我仔细看看手中的银钥匙','银钥匙','look'],
    ['仔细观察背包里的这枚印玺','印玺','look'],
  ])('所指物品必须已经随身携带：%s', (input, name, inspection) => {
    expect(read(input)?.object).toEqual({kind:'use',object:name,inspection,inventoryOnly:true});
  });

  it('物品名称和后续动作中提到背包，不算从包中取出物品', () => {
    expect(read('我端详背包里的秘密',['背包里的秘密'])?.object)
      .toEqual({kind:'use',object:'背包里的秘密',inspection:'look'});
    expect(read('我端详银钥匙，然后查看背包里的印玺')?.object)
      .toEqual({kind:'use',object:'银钥匙',inspection:'look'});
  });

  it('优先匹配整个已知物品名，再考虑其后的目视动作', () => {
    expect(read('我拿起回眸一看',['回眸一看'])?.object)
      .toEqual({kind:'use',object:'回眸一看'});
  });

  it('口语“看了下”也能绑定现场物件的别名', () => {
    expect(read('我看了下铜尺', ['铸钟量规', '铜尺'])?.object)
      .toEqual({kind:'use',object:'铜尺',inspection:'look'});
  });

  it.each([
    ['我拿起王室印玺的仿品仔细看','王室印玺的仿品'],
    ['我拿起银钥匙盒看看','银钥匙盒'],
    ['我拿起密信细看','密信'],
  ])('未知物品保留完整宾语，不借用已知物品：%s',(input,name) => {
    expect(read(input)?.object).toEqual({kind:'use',object:name, inspection:'handle'});
  });

  it.each([
    '我没拿起印玺仔细看','如果我拿起印玺仔细看','我看到艾琳拿起王印仔细看','艾琳拿起王印仔细看',
    '拿起印玺仔细看吗？','我对罗兰说：“我拿起王印仔细看。”','我让艾琳拿起王印仔细看',
    '我从艾琳的口袋里拿起印玺仔细看','我拿起密信，仔细看看王室印玺',
    '我看着王室印玺旁边的宫门','我端详印玺的画像','我没有仔细看银钥匙',
    '我拿起王印仔细看，不，我收回这个决定。',
    '我拿起王印细看，还是不拿了。',
  ])('不能因提到物品而替玩家查看：%s', input => {
    const result = read(input)?.object;
    expect(result?.inspection).toBeUndefined();
  });

  it('保留文书、通用调查与看向地点的既有路径', () => {
    expect(read('我仔细看长桌')?.reading?.target).toBe('长桌');
    expect(read('我检查登记簿')?.object).toEqual({kind:'investigate',object:'登记簿'});
    expect(read('我看向宫门')?.intent.kind).toBe('look');
  });
});
