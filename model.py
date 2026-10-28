"""15-state system (3) from the supplied Putilov draft, not the older NPV model.
OLS coefficients: supplied 2015–2022 Excel, each column divided by its maximum.
External functions are REQUIRED user inputs. No inferred climate/brigade units.
No clipping of negative states. See method.html for source discrepancies.
"""
import ast
import json
import math
import operator
from pathlib import Path
from copy import deepcopy
import numpy as np
from scipy.integrate import solve_ivp

DATA = json.loads((Path(__file__).parent / 'source_data.json').read_text())
class InputError(ValueError): pass

def number(v, label, lo=-1e12, hi=1e12):
    if v is None or isinstance(v, bool) or isinstance(v, str) and not v.strip():
        raise InputError(label + ': заполните поле.')
    try: v = float(v.replace(',', '.') if isinstance(v, str) else v)
    except (TypeError, ValueError): raise InputError(label + ': требуется число.')
    if not math.isfinite(v) or not lo <= v <= hi: raise InputError(f'{label}: допустимо от {lo:g} до {hi:g}.')
    return v

OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
       ast.Div: operator.truediv, ast.Pow: operator.pow}
FUNCS = {'sin': math.sin, 'cos': math.cos, 'exp': math.exp, 'log': math.log,
         'sqrt': math.sqrt, 'abs': abs}
class Expression:
    """Restricted arithmetic AST: never eval user text or allow attributes/imports."""
    def __init__(self, text, names, label, functions=None):
        self.label = label
        self.functions = {**FUNCS, **(functions or {})}
        if not isinstance(text, str) or not text.strip() or len(text) > 1500:
            raise InputError(label + ': введите формулу (до 1500 символов).')
        try: self.tree = ast.parse(text.strip(), mode='eval').body
        except SyntaxError: raise InputError(label + ': ошибка записи, используйте точку и ** для степени.')
        if len(list(ast.walk(self.tree))) > 400: raise InputError(label + ': формула слишком сложная.')
        def check(n, depth=0):
            if depth > 60: raise InputError(label + ': слишком большая вложенность.')
            if isinstance(n, ast.Constant):
                if type(n.value) not in (float, int) or abs(n.value) > 1e12 or not math.isfinite(n.value):
                    raise InputError(label + ': недопустимая константа.')
            elif isinstance(n, ast.Name):
                if n.id not in names: raise InputError(label + ': неизвестная переменная ' + n.id)
            elif isinstance(n, ast.BinOp) and type(n.op) in OPS:
                check(n.left, depth+1); check(n.right, depth+1)
            elif isinstance(n, ast.UnaryOp) and type(n.op) in (ast.UAdd, ast.USub): check(n.operand, depth+1)
            elif isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in self.functions and len(n.args)==1 and not n.keywords:
                check(n.args[0], depth+1)
            else: raise InputError(label + ': разрешены только арифметика и перечисленные функции.')
        check(self.tree)
    def __call__(self, env):
        def run(n):
            if isinstance(n, ast.Constant): return float(n.value)
            if isinstance(n, ast.Name): return env[n.id]
            if isinstance(n, ast.UnaryOp): return -run(n.operand) if isinstance(n.op, ast.USub) else run(n.operand)
            if isinstance(n, ast.Call): return self.functions[n.func.id](run(n.args[0]))
            a,b=run(n.left),run(n.right)
            if isinstance(n.op, ast.Pow) and abs(b)>12: raise ValueError('модуль степени больше 12')
            return OPS[type(n.op)](a,b)
        try:
            v=float(run(self.tree))
            if not math.isfinite(v) or abs(v)>1e15: raise ValueError('неограниченное значение')
            return v
        except (ValueError, TypeError, OverflowError, ZeroDivisionError) as e:
            raise InputError(f'{self.label}: формула не определена ({e}).')

def default_parts():
    plus=[]; minus=[]
    for eq in DATA['equations']:
        def product(ids):
            return '*'.join(f'f{k}(x{DATA["polynomials"][k-1]["input"]})' for k in ids)
        def external(ids): return '(' + '+'.join(f'e{k}' for k in ids) + ')'
        a=product(eq['positive'])
        if eq['external_positive']: a+='*'+external(eq['external_positive'])
        b=product(eq['negative'])
        if eq['external_negative']: b+='*'+external(eq['external_negative'])
        if eq['external_subtract']: b=external(eq['external_subtract'])
        plus.append(a or '0'); minus.append(b or '0')
    return plus,minus

def fit_coefficients():
    """Reproduce all 78 fits directly from the eight raw observations."""
    raw=np.array(DATA['raw'], dtype=float); normalized=raw/raw.max(axis=0)
    out=[]
    for p in DATA['polynomials']:
        u=normalized[:,p['input']-1]; v=normalized[:,p['target']-1]
        design=np.column_stack([np.ones(len(u)),u,u*u])
        coefficients=np.linalg.lstsq(design,v,rcond=None)[0]
        r2=1-float(np.sum((v-design@coefficients)**2)/np.sum((v-v.mean())**2))
        out.append({**p,'coefficients':coefficients.tolist(),'r2':r2})
    return out

DATA['polynomials']=fit_coefficients()
PLUS, MINUS = default_parts()
DEFAULT = dict(duration=.7, steps=200, method='RK4', initial=DATA['normalized'][0],
    forcing=['']*5, plus=PLUS, minus=MINUS, target=DATA['limits'][2], weights=[1/15]*15,
    polynomials=[' + '.join(f'({v:.16g})'+('' if k==0 else '*u' if k==1 else '*u**2')
                  for k,v in enumerate(p['coefficients'])) for p in DATA['polynomials']])

def parameters(raw):
    if not isinstance(raw, dict): raise InputError('Ожидается набор параметров.')
    p=deepcopy(DEFAULT);p.update({k:v for k,v in raw.items() if k in DEFAULT})
    p['duration']=number(p['duration'],'Конец интервала',.001,5)
    steps=number(p['steps'],'Число шагов',20,4000)
    if steps!=int(steps) or int(steps)%4: raise InputError('Число шагов должно быть целым и кратным четырём.')
    p['steps']=int(steps)
    if p['method'] not in ['RK4','RK45']: raise InputError('Метод: RK4 или RK45.')
    for key, count in [('initial',15),('target',15),('weights',15),('forcing',5),('plus',15),('minus',15),('polynomials',78)]:
        if not isinstance(p[key],list) or len(p[key])!=count: raise InputError(f'{key}: требуется {count} значений.')
    for key in ['initial','target','weights']:
        p[key]=[number(v,f'{key}, X{i+1}',0,1e6) for i,v in enumerate(p[key])]
    if sum(p['weights'])==0: raise InputError('Хотя бы один вес критерия должен быть положительным.')
    return p

def prepare(p):
    polys=[Expression(s,{'u'},f'f{i+1}') for i,s in enumerate(p['polynomials'])]
    funcs={f'f{i+1}':(lambda u, f=f:f({'u':u})) for i,f in enumerate(polys)}
    forcing=[Expression(s,{'t'},f'E{i+1}(t)') for i,s in enumerate(p['forcing'])]
    names={'t'}|{f'x{i}' for i in range(1,16)}|{f'e{i}' for i in range(1,6)}
    plus=[Expression(s,names,f'X{i+1}, положительный член',funcs) for i,s in enumerate(p['plus'])]
    minus=[Expression(s,names,f'X{i+1}, вычитаемый член',funcs) for i,s in enumerate(p['minus'])]
    target=np.array(p['target']);weights=np.array(p['weights']);calls=0
    def factors(t): return [f({'t':float(t)}) for f in forcing]
    def rhs(t,y):
        nonlocal calls
        calls+=1
        if calls>150000: raise InputError('Превышен предел вычислений. Уменьшите интервал или проверьте формулы.')
        env={'t':float(t),**{f'x{i+1}':float(v) for i,v in enumerate(y[:15])},**{f'e{i+1}':v for i,v in enumerate(factors(t))}}
        values=[a(env)-b(env) for a,b in zip(plus,minus)]
        return np.array(values+[float(np.sum(weights*(y[:15]-target)**2))])
    return rhs,factors

def rk4(rhs, initial, T, n):
    t=np.linspace(0,T,n+1); y=np.empty((len(initial),n+1));y[:,0]=initial;h=T/n
    for k in range(n):
        a=rhs(t[k],y[:,k]);b=rhs(t[k]+h/2,y[:,k]+h*a/2)
        c=rhs(t[k]+h/2,y[:,k]+h*b/2);d=rhs(t[k+1],y[:,k]+h*c)
        y[:,k+1]=y[:,k]+h*(a+2*b+2*c+d)/6
        if not np.all(np.isfinite(y[:,k+1])) or np.max(np.abs(y[:,k+1]))>1e9:
            raise InputError(f'Решение неограниченно при t≈{t[k+1]:.6g}. Проверьте входные данные.')
    return t,y

def simulate(raw, verify=True):
    p=parameters(raw);rhs,factors=prepare(p);T=p['duration'];n=p['steps'];initial=p['initial']+[0.]
    if p['method']=='RK4':
        t,y=rk4(rhs,initial,T,n)
        _,fine=rk4(rhs,initial,T,2*n) if verify else (None,y)
        difference=float(np.max(np.abs(y-fine[:,::2]))) if verify else None
    else:
        t=np.linspace(0,T,n+1)
        sol=solve_ivp(rhs,(0,T),initial,t_eval=t,method='RK45',rtol=1e-9,atol=1e-11,max_step=T/100)
        if not sol.success: raise InputError('RK45 не завершил расчёт: '+sol.message)
        y=sol.y;difference=None
    states=y[:15];ff=np.array([factors(ti) for ti in t]).T
    invalid=np.argwhere(states < -1e-10);negative=sorted(set(int(i+1) for i,j in invalid))
    first_negative=float(min(t[j] for i,j in invalid)) if len(invalid) else None
    warnings=[]
    if negative: warnings.append('Отрицательные показатели '+', '.join(f'X{i}' for i in negative)+f' (первый узел t={first_negative:.6g}). Траектория не имеет физической интерпретации на всём интервале; значения не обрезаны.')
    mins=np.min(DATA['normalized'],axis=0);maxs=np.max(DATA['normalized'],axis=0)
    outside=np.any((states<mins[:,None])|(states>maxs[:,None]),axis=1)
    if np.any(outside): warnings.append('Есть выход за диапазон статистики 2015–2022: это экстраполяция регрессий.')
    if np.any(ff<0): warnings.append('Есть отрицательные значения внешних факторов. Проверьте их интерпретацию и формулы.')
    if difference is not None and difference>1e-5: warnings.append('При удвоении числа шагов изменение превышает 1e−5. Увеличьте число шагов.')
    canonical=p['plus']==PLUS and p['minus']==MINUS and p['polynomials']==DEFAULT['polynomials']
    comparison=None
    if abs(T-.7)<1e-12 and np.allclose(p['initial'],DATA['normalized'][0],rtol=0,atol=1e-12):
        observed=np.array(DATA['normalized']).T
        estimated=np.array([np.interp(np.arange(8)/10,t,row) for row in states])
        error=100*np.abs(estimated-observed)/observed
        comparison=dict(estimated=estimated.tolist(),mape=error.mean(axis=1).tolist(),max_error=error.max(axis=1).tolist())
    return dict(parameters=p,t=t.tolist(),series=states.tolist(),forcing=ff.tolist(),criterion=y[15].tolist(),
        snapshots=[dict(t=float(t[k]),tau=k/n,values=states[:,k].tolist()) for k in [0,n//4,n//2,3*n//4,n]],
        comparison=comparison,diagnostics=dict(negative=negative,first_negative=first_negative,minimum=float(states.min()),
            step_difference=difference,canonical=canonical,valid_physical=not negative and not np.any(ff<0)),warnings=warnings)

def dispatch(request):
    mode=request.get('action')
    if mode=='defaults': return DEFAULT
    if mode=='simulate': return simulate(request.get('parameters',{}))
    if mode=='experiments':
        p=parameters(request.get('parameters',{}))
        # Five initial states are observed rows, not assumed percentage reductions.
        return [dict(name=f'Начальное состояние {DATA["years"][i]}',year=DATA['years'][i],
            result=simulate({**p,'initial':DATA['normalized'][i]})) for i in [0,1,3,5,7]]
    raise InputError('Неизвестная операция.')

if __name__=='__main__':
    import sys
    print(json.dumps(dispatch(json.load(sys.stdin)),ensure_ascii=False,allow_nan=False))
