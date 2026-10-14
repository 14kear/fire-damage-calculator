"""FireLab 2.0. Economic fire-loss assessment.
Dynamic core: Van Coile et al., FPRF-2022-13, section 2.3,
finite-horizon equations (7), (9), (11), (13), (19), (22).
Six ODEs are derivatives of published cumulative integrals, not fire physics.
Time: years; constant-price RUB. Defaults: lab 1 control data, identical losses
in both designs (neutral control). Sensitivity settings are scenarios, not data.
"""
import ast
import json
import math
import operator
from copy import deepcopy
import numpy as np
from scipy.integrate import solve_ivp

VERSION='2.0'
LABELS=['Прямые потери базы Cdd₀','Косвенные потери базы Cid₀',
        'Прямые потери варианта Cdd₁','Косвенные потери варианта Cid₁',
        'Обслуживание CM','Замена при обновлении объекта CA']
FORCING_KEYS=['lambda0','lambda1','dd0','di0','dd1','di1','maintenance','omega']
FORCING_LABELS=['λ₀, 1/год','λ₁, 1/год','Dd₀, руб./пожар','Di₀, руб./пожар',
                'Dd₁, руб./пожар','Di₁, руб./пожар','cM, руб./год','ω, 1/год']
F_DEFAULT=dict(lambda0='frequency',lambda1='frequency',dd0='direct',di0='indirect',
               dd1='protected_direct',di1='protected_indirect',maintenance='operating',omega='renewal')
RHS_DEFAULT=['lambda0*dd0*exp(-gamma*t)','lambda0*di0*exp(-gamma*t)',
             'lambda1*dd1*exp(-gamma*t)','lambda1*di1*exp(-gamma*t)',
             'maintenance*exp(-gamma*t)','investment*omega*exp(-gamma*t)']
DEFAULT=dict(duration=10.,discount=.05,frequency=.02,direct=910000.,indirect=480000.,
             protected_direct=910000.,protected_indirect=480000.,investment=40000.,
             operating=1000.,renewal=0.,initial=[0.]*6,forcing=F_DEFAULT,
             plus=RHS_DEFAULT,minus=['0']*6,breakpoints=[],
             price_date='Учебная единая дата цен из лабораторной 1',
             data_source='Лабораторная 1, раздел 12; одинаковые потери вариантов — нейтральный контроль')

class InputError(ValueError): pass

def num(v,name,low=0.,high=1e15):
    if v is None or isinstance(v,bool) or (isinstance(v,str) and not v.strip()):
        raise InputError(f'{name}: заполните числовое поле.')
    try: x=float(v.replace(',','.').replace(' ','').replace('\u00a0','').replace('\u202f','') if isinstance(v,str) else v)
    except (ValueError,TypeError): raise InputError(f'{name}: требуется число.')
    if not math.isfinite(x) or not low<=x<=high: raise InputError(f'{name}: допустимо от {low:g} до {high:g}.')
    return x

# Restricted arithmetic interpreter: no eval, attributes, indexing or Python code.
FUNCS={'exp':math.exp,'log':math.log,'sqrt':math.sqrt,'sin':math.sin,'cos':math.cos,
       'abs':abs,'min':min,'max':max}
OPS={ast.Add:operator.add,ast.Sub:operator.sub,ast.Mult:operator.mul,ast.Div:operator.truediv,
     ast.Pow:operator.pow}
CMPS={ast.Lt:operator.lt,ast.LtE:operator.le,ast.Gt:operator.gt,ast.GtE:operator.ge,
      ast.Eq:operator.eq,ast.NotEq:operator.ne}

class Expression:
    def __init__(self,text,names,label):
        self.label=label
        if not isinstance(text,str) or not text.strip() or len(text)>400:
            raise InputError(label+': нужна формула длиной до 400 символов.')
        try: self.tree=ast.parse(text,mode='eval').body
        except SyntaxError: raise InputError(label+': ошибка записи формулы; десятичный разделитель — точка.')
        nodes=list(ast.walk(self.tree))
        if len(nodes)>100: raise InputError(label+': формула слишком сложная.')
        def check(n,depth=0):
            if depth>20: raise InputError(label+': слишком большая вложенность.')
            if isinstance(n,ast.Constant):
                if type(n.value) not in (int,float) or not math.isfinite(n.value) or abs(n.value)>1e15: raise InputError(label+': недопустимая константа.')
            elif isinstance(n,ast.Name):
                if n.id not in names: raise InputError(label+': неизвестное имя '+n.id)
            elif isinstance(n,ast.BinOp) and type(n.op) in OPS:
                check(n.left,depth+1);check(n.right,depth+1)
            elif isinstance(n,ast.UnaryOp) and isinstance(n.op,(ast.UAdd,ast.USub)): check(n.operand,depth+1)
            elif isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id in FUNCS and not n.keywords and 1<=len(n.args)<=4:
                for a in n.args:check(a,depth+1)
            elif isinstance(n,ast.IfExp):
                check(n.test,depth+1);check(n.body,depth+1);check(n.orelse,depth+1)
            elif isinstance(n,ast.Compare) and len(n.ops)==1 and type(n.ops[0]) in CMPS:
                check(n.left,depth+1);check(n.comparators[0],depth+1)
            else: raise InputError(label+': разрешены только арифметика, функции и условие a if t < b else c.')
        check(self.tree)
    def __call__(self,env):
        def run(n):
            if isinstance(n,ast.Constant):return float(n.value)
            if isinstance(n,ast.Name):return env[n.id]
            if isinstance(n,ast.UnaryOp):return -run(n.operand) if isinstance(n.op,ast.USub) else run(n.operand)
            if isinstance(n,ast.BinOp):
                a,b=run(n.left),run(n.right)
                if isinstance(n.op,ast.Pow) and abs(b)>16:raise ValueError('модуль степени не больше 16')
                return OPS[type(n.op)](a,b)
            if isinstance(n,ast.Call):return FUNCS[n.func.id](*(run(a) for a in n.args))
            if isinstance(n,ast.Compare):return CMPS[type(n.ops[0])](run(n.left),run(n.comparators[0]))
            if isinstance(n,ast.IfExp):return run(n.body if run(n.test) else n.orelse)
        try:
            v=float(run(self.tree))
            if not math.isfinite(v) or abs(v)>1e18:raise ValueError('неограниченное значение')
            return v
        except (ValueError,ZeroDivisionError,OverflowError,TypeError,KeyError) as e:
            raise InputError(f'{self.label}: формула не определена при t={env.get("t",0):g}: {e}')

def parameters(raw):
    if not isinstance(raw,dict):raise InputError('Параметры должны быть объектом.')
    p=deepcopy(DEFAULT)
    for k in ['duration','discount','frequency','direct','indirect','protected_direct','protected_indirect','investment','operating','renewal']:
        p[k]=num(raw.get(k,p[k]),k)
    if not .01<=p['duration']<=100:raise InputError('Горизонт: от 0,01 до 100 лет.')
    if p['discount']>1:raise InputError('Ставка: от 0 до 1.')
    if p['frequency']>100 or p['renewal']>100:raise InputError('Частота: не более 100 в год.')
    for k in ['initial','plus','minus']:
        v=raw.get(k,p[k])
        if not isinstance(v,list) or len(v)!=6:raise InputError(k+': требуется шесть значений.')
        p[k]=[num(x,'Начальное состояние') for x in v] if k=='initial' else v.copy()
    f=raw.get('forcing',p['forcing'])
    if not isinstance(f,dict) or set(f)!=set(FORCING_KEYS):raise InputError('Требуются все восемь формул внешних факторов.')
    p['forcing']=f.copy()
    br=raw.get('breakpoints',[])
    if not isinstance(br,list) or len(br)>100:raise InputError('Не более 100 точек разрыва.')
    p['breakpoints']=sorted(set(num(v,'Точка разрыва',0,p['duration']) for v in br))
    for k in ['price_date','data_source']:
        v=raw.get(k,p[k])
        if not isinstance(v,str) or not v.strip() or len(v)>1000:raise InputError(k+': укажите основание данных (до 1000 символов).')
        p[k]=v
    return p

def simulate(raw=None,rtol=1e-9,method='RK45'):
    p=parameters(raw or {})
    env={k:v for k,v in p.items() if isinstance(v,(int,float))}
    env.update(T=p['duration'],gamma=math.log1p(p['discount']),pi=math.pi)
    f=[Expression(p['forcing'][k],set(env)|{'t'},k) for k in FORCING_KEYS]
    allowed=set(env)|{'t'}|set(FORCING_KEYS)|{f'x{i}' for i in range(1,7)}
    plus=[Expression(s,allowed,f'f{i+1}+') for i,s in enumerate(p['plus'])]
    minus=[Expression(s,allowed,f'f{i+1}-') for i,s in enumerate(p['minus'])]
    calls=0
    def factors(t):
        e={**env,'t':t};vals=[ex(e) for ex in f]
        if min(vals)<0:raise InputError('Внешние факторы не могут быть отрицательными.')
        if max(vals[0],vals[1],vals[-1])>100:raise InputError('Частота фактора превышает 100 в год.')
        return vals
    def rhs(t,y):
        nonlocal calls
        calls+=1
        if calls>30000:raise InputError('Превышен лимит вычислений. Проверьте формулы и точки разрывов.')
        e={**env,'t':t,**dict(zip(FORCING_KEYS,factors(t))),**{f'x{i+1}':float(v) for i,v in enumerate(y)}}
        a=[ex(e) for ex in plus];b=[ex(e) for ex in minus]
        if min(a+b)<0:raise InputError('Потоки f+ и f− должны быть неотрицательными.')
        return np.array(a)-np.array(b)
    T=p['duration'];t=np.linspace(0,T,241);z=np.zeros((6,241));z[:,0]=p['initial'];state=np.array(p['initial']);nfev=0
    edges=sorted(set([0.,T]+p['breakpoints']))
    for left,right in zip(edges,edges[1:]):
        # End-point evaluations stay inside each piece; prevents discontinuity smearing.
        def segment_rhs(tt,y):return rhs(min(max(tt,np.nextafter(left,right)),np.nextafter(right,left)),y)
        sol=solve_ivp(segment_rhs,(left,right),state,method=method,rtol=rtol,atol=1e-7,
                       max_step=T/120,dense_output=True)
        if not sol.success:raise InputError('Численное решение не получено.')
        mask=(t>left)&(t<=right);z[:,mask]=sol.sol(t[mask]);state=sol.y[:,-1];nfev+=sol.nfev
    if not np.all(np.isfinite(z)) or np.min(z)<-1e-5:raise InputError('Получены недопустимые накопленные затраты.')
    z=np.maximum(z,0)
    ff=np.array([factors(float(tt)) for tt in t]).T
    baseline=z[0]+z[1];protected=z[2]+z[3];cost=p['investment']+z[4]+z[5];benefit=baseline-protected;npv=benefit-cost
    scale=np.maximum(z.max(axis=1),1.)
    snaps=[dict(t=float(t[j]),tau=j/240,values=z[:,j].tolist(),normalized=(z[:,j]/scale).tolist()) for j in [0,60,120,180,240]]
    canonical=p['plus']==RHS_DEFAULT and p['minus']==['0']*6
    analytic=None
    if canonical and p['forcing']==F_DEFAULT:
        g=env['gamma'];A=T if g==0 else -math.expm1(-g*T)/g
        rates=[p['frequency']*p['direct'],p['frequency']*p['indirect'],p['frequency']*p['protected_direct'],p['frequency']*p['protected_indirect'],p['operating'],p['investment']*p['renewal']]
        expected=np.array(p['initial'])+A*np.array(rates)
        analytic=dict(values=expected.tolist(),max_abs_error=float(np.max(abs(z[:,-1]-expected))),factor=A)
    return dict(version=VERSION,parameters=p,t=t.tolist(),series=z.tolist(),forcing=ff.tolist(),
                snapshots=snaps,scales=scale.tolist(),npv=npv.tolist(),baseline=baseline.tolist(),protected=protected.tolist(),
                solver='SciPy solve_ivp / '+method,canonical=canonical,analytic=analytic,
                metrics=dict(baseline=float(baseline[-1]),protected=float(protected[-1]),benefit=float(benefit[-1]),
                    costs=float(cost[-1]),npv=float(npv[-1]),bcr=float(benefit[-1]/cost[-1]) if cost[-1] else None),
                diagnostics=dict(nfev=nfev,minimum=float(np.min(z))))

def experiments(raw=None):
    p=parameters(raw or {})
    # Reference series always uses published integrands and zero initial integrals.
    p.update(plus=RHS_DEFAULT.copy(),minus=['0']*6,forcing=deepcopy(F_DEFAULT),initial=[0.]*6,breakpoints=[])
    variants=[('Одинаковые потери',dict(protected_direct=p['direct'],protected_indirect=p['indirect'])),
              ('Прямые потери −20%',dict(protected_direct=.8*p['direct'],protected_indirect=p['indirect'])),
              ('Косвенные потери −50%',dict(protected_direct=p['direct'],protected_indirect=.5*p['indirect'])),
              ('Совместное снижение',dict(protected_direct=.8*p['direct'],protected_indirect=.5*p['indirect'])),
              ('Рост частоты',dict(protected_direct=.8*p['direct'],protected_indirect=.5*p['indirect'],
                 forcing={**F_DEFAULT,'lambda0':'frequency*(1+t/T)','lambda1':'frequency*(1+t/T)'}))]
    out=[dict(name=n,result=simulate({**p,**change})) for n,change in variants]
    # Shared per-axis scales across the entire series, no independent misleading scaling.
    scales=np.maximum(np.max([np.max(x['result']['series'],axis=1) for x in out],axis=0),1.)
    for x in out:
        r=x['result'];r['scales']=scales.tolist()
        for s in r['snapshots']:s['normalized']=(np.array(s['values'])/scales).tolist()
    return out

def calculate(raw):
    if not isinstance(raw,dict): raise InputError('Ожидается объект параметров.')
    items=raw.get('items',[])
    if not isinstance(items,list) or not items: raise InputError('Добавьте хотя бы одну позицию имущества.')
    if len(items)>100: raise InputError('Не более 100 позиций.')
    losses=[num(x.get('quantity'),'Количество')*num(x.get('price'),'Цена')*num(x.get('damage'),'Повреждение',0,1) for x in items]
    gross=sum(losses); salvage=num(raw.get('salvage'),'Остатки',0,gross)
    direct=gross-salvage+num(raw.get('extra'),'Дополнительные расходы')
    indirect=(num(raw.get('revenue'),'Выручка')*num(raw.get('margin'),'Маржинальность',0,1)*num(raw.get('days'),'Дни простоя')*
              num(raw.get('outage'),'Утрата продаж',0,1)+num(raw.get('temporary'),'Временные расходы'))
    periods=raw.get('periods')
    if periods is not None:
        if not isinstance(periods,list) or not 1<=len(periods)<=1000:raise InputError('От 1 до 1000 периодов простоя.')
        indirect=num(raw.get('temporary'),'Временные расходы')
        for row in periods:
            if not isinstance(row,dict):raise InputError('Неверный период.')
            baseline=num(row.get('baseline'),'Выручка без пожара')
            actual=num(row.get('actual'),'Фактическая выручка',0,baseline)
            indirect+=num(row.get('days'),'Длительность периода')*(baseline-actual)*num(row.get('margin'),'Маржинальность',0,1)
    scenarios=raw.get('scenarios',[])
    if not isinstance(scenarios,list) or not scenarios: raise InputError('Добавьте сценарии.')
    probs=[num(s.get('p'),'Вероятность',0,1) for s in scenarios]
    protected=[num(s.get('protected'),'Вероятность с защитой',0,1) for s in scenarios]
    if abs(sum(probs)-1)>1e-8 or abs(sum(protected)-1)>1e-8: raise InputError('Сумма вероятностей в каждом варианте должна быть равна 1.')
    damages=[num(s.get('loss'),'Ущерб сценария') for s in scenarios]
    mean=sum(p*u for p,u in zip(probs,damages)); mean2=sum(p*u for p,u in zip(protected,damages))
    rate=num(raw.get('frequency'),'Частота',0,100)
    eal=rate*mean;eal2=rate*mean2; benefit=eal-eal2
    investment=num(raw.get('investment'),'Вложения'); operating=num(raw.get('operating'),'Обслуживание')
    years=num(raw.get('years'),'Горизонт',1,100)
    if int(years)!=years: raise InputError('Горизонт задаётся целым числом лет.')
    r=num(raw.get('discount'),'Ставка',0,1)
    annuity=years if r==0 else -math.expm1(-years*math.log1p(r))/r
    pv_cost=investment+operating*annuity; npv=-investment+(benefit-operating)*annuity
    flows=raw.get('annual_flows')
    cashflows=[{'year':t,'npv':-investment+(benefit-operating)*(t if r==0 else -math.expm1(-t*math.log1p(r))/r)} for t in range(int(years)+1)]
    pv_benefit=benefit*annuity
    if flows is not None:
        if not isinstance(flows,list) or len(flows)!=int(years):raise InputError('Укажите поток для каждого года горизонта.')
        by_year={}
        for row in flows:
            if not isinstance(row,dict):raise InputError('Неверный денежный поток.')
            year=num(row.get('year'),'Год',1,years)
            if int(year)!=year or year in by_year:raise InputError('Годы должны быть целыми и не повторяться.')
            by_year[year]=row
        pv_benefit=0.;pv_cost=investment;cashflows=[dict(year=0,npv=-investment)]
        for year in range(1,int(years)+1):
            row=by_year[year];discount=(1+r)**year
            pv_benefit+=(num(row.get('benefit'),'Предотвращённые потери')+num(row.get('residual'),'Остаточная стоимость'))/discount
            pv_cost+=(num(row.get('operating'),'Обслуживание')+num(row.get('replacement'),'Замена'))/discount
            cashflows.append(dict(year=year,npv=pv_benefit-pv_cost))
        npv=pv_benefit-pv_cost
    return dict(items=losses,gross=gross,direct=direct,indirect=indirect,total=direct+indirect,
                mean=mean,protected_mean=mean2,eal=eal,protected_eal=eal2,benefit=benefit,
                annuity=annuity,npv=npv,bcr=(pv_benefit/pv_cost if pv_cost else None),cashflows=cashflows,
                business_mode='periods' if periods is not None else 'constant',
                cashflow_mode='annual_rows' if flows is not None else 'annuity')

CONTROL=dict(items=[dict(name='Отделка',quantity=200,price=3000,damage=.6),dict(name='Оборудование',quantity=5,price=120000,damage=.5),dict(name='Запасы',quantity=1,price=250000,damage=.8)],salvage=40000,extra=90000,revenue=80000,margin=.35,days=20,outage=.75,temporary=60000,scenarios=[dict(name='Локальный',p=.70,protected=.85,loss=300000),dict(name='Существенный',p=.25,protected=.13,loss=1400000),dict(name='Тяжёлый',p=.05,protected=.02,loss=6000000)],frequency=.02,investment=40000,operating=1000,years=10,discount=.05)

def dispatch(request):
    if not isinstance(request,dict):raise InputError('Запрос должен быть объектом.')
    action=request.get('action','simulate'); p=request.get('parameters',{})
    if action=='simulate': return simulate(p)
    if action=='experiments': return experiments(p)
    if action=='calculate': return calculate(p)
    raise InputError('Неизвестная операция.')

if __name__=='__main__':
    import argparse,pathlib
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',default='experiments.json')
    args=parser.parse_args()
    pathlib.Path(args.output).write_text(json.dumps({'experiments':experiments(),'control':calculate(CONTROL)},ensure_ascii=False,indent=2),encoding='utf-8')
    print(f'Результаты сохранены: {args.output}')
