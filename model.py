"""Математическая модель системной динамики последствий пожаров (15 уравнений, 5 возмущений, 78 полиномов).
Не требует сторонних библиотек — работает на чистом Python 3.
"""
import json
import math
from copy import deepcopy
from pathlib import Path

DATA = json.loads((Path(__file__).parent / 'source_data.json').read_text(encoding='utf-8'))


class InputError(ValueError):
    pass


def clean_num(v):
    v = float(v)
    return 0.0 if abs(v) < 1e-10 else round(v, 6)


def parse_number(v, label, lo=-1e6, hi=1e6):
    if v is None or isinstance(v, bool) or (isinstance(v, str) and not v.strip()):
        raise InputError(f'{label}: заполните поле.')
    try:
        val = float(v.replace(',', '.') if isinstance(v, str) else v)
    except (TypeError, ValueError):
        raise InputError(f'{label}: требуется число.')
    if not math.isfinite(val) or not (lo - 1e-12 <= val <= hi + 1e-12):
        raise InputError(f'{label}: допустимо значение от {lo:g} до {hi:g}.')
    return max(lo, min(hi, val))


def build_base_functions():
    raw_cat = DATA['function_catalogs']['article']
    out = {}
    for k in range(1, 79):
        item = raw_cat[str(k)]
        out[str(k)] = {
            'id': item['id'],
            'input': item['input'],
            'target': item['target'],
            'c2': clean_num(item['c']),
            'c1': clean_num(item['b']),
            'c0': clean_num(item['a']),
        }
    return out


BASE_FUNCTIONS = build_base_functions()

DEFAULT_PERTURBATIONS = [
    {'a': 0.00, 'b': 0.05, 'c': 0.35},
    {'a': 0.00, 'b': 0.15, 'c': 0.30},
    {'a': 0.00, 'b': 0.00, 'c': 0.15},
    {'a': 0.00, 'b': 0.05, 'c': 0.15},
    {'a': 0.00, 'b': 0.10, 'c': 0.25},
]

DEFAULT = {
    'duration': 1.0,
    'steps': 200,
    'initial': [round(float(x), 4) for x in DATA['article_initial']],
    'limits': [round(float(x), 3) for x in DATA['limits'][2]],
    'perturbations': deepcopy(DEFAULT_PERTURBATIONS),
    'functions': {},
}


def validate_parameters(raw):
    if not isinstance(raw, dict):
        raise InputError('Требуется набор числовых параметров.')
    p = deepcopy(DEFAULT)
    for k in DEFAULT:
        if k in raw:
            p[k] = raw[k]

    p['duration'] = parse_number(p['duration'], 'Интервал времени T', 0.1, 1.0)
    steps = parse_number(p['steps'], 'Число шагов', 20, 2000)
    if int(steps) != steps or int(steps) % 4 != 0:
        raise InputError('Число шагов должно быть целым и кратным 4.')
    p['steps'] = int(steps)

    for key, title in (('initial', 'Начальное условие'), ('limits', 'Допустимое значение')):
        arr = p[key]
        if not isinstance(arr, list) or len(arr) != 15:
            raise InputError(f'{title}: требуется 15 значений.')
        p[key] = [parse_number(v, f'{title} X{i + 1}', 0.0, 1.0) for i, v in enumerate(arr)]

    perts = p['perturbations']
    if not isinstance(perts, list) or len(perts) != 5:
        raise InputError('Возмущения: требуется 5 функций E₁…E₅.')
    clean_perts = []
    for m, spec in enumerate(perts):
        if not isinstance(spec, dict):
            raise InputError(f'Возмущение E{m + 1}: некорректный формат.')
        clean_perts.append({
            'a': parse_number(spec.get('a', 0.0), f'E{m + 1}, коэф. при t²', 0.0, 1.0),
            'b': parse_number(spec.get('b', 0.0), f'E{m + 1}, коэф. при t', 0.0, 1.0),
            'c': parse_number(spec.get('c', 0.0), f'E{m + 1}, свободный член', 0.0, 1.0),
        })
    p['perturbations'] = clean_perts

    funcs = p.get('functions') or {}
    if not isinstance(funcs, dict):
        raise InputError('Некорректный формат внутренних функций.')
    merged_funcs = deepcopy(BASE_FUNCTIONS)
    for fid, spec in funcs.items():
        key = str(fid)
        if key not in merged_funcs or not isinstance(spec, dict):
            raise InputError(f'Неизвестная функция f{fid}.')
        merged_funcs[key]['c2'] = parse_number(spec.get('c2', merged_funcs[key]['c2']), f'f{key}, коэф. X²', -1e4, 1e4)
        merged_funcs[key]['c1'] = parse_number(spec.get('c1', merged_funcs[key]['c1']), f'f{key}, коэф. X', -1e4, 1e4)
        merged_funcs[key]['c0'] = parse_number(spec.get('c0', merged_funcs[key]['c0']), f'f{key}, своб. член', -1e4, 1e4)
    p['resolved_functions'] = merged_funcs
    return p


def eval_perturbation(spec, t):
    val = spec['a'] * t * t + spec['b'] * t + spec['c']
    return max(0.0, min(1.0, val))


def simulate(raw=None):
    p = validate_parameters(raw or {})
    funcs = p['resolved_functions']
    perts = p['perturbations']
    limits = p['limits']
    equations = DATA['equations']
    T = p['duration']
    n = p['steps']
    h = T / n

    fn_list = [None] * 79
    for k in range(1, 79):
        fk = funcs[str(k)]
        fn_list[k] = (fk['input'] - 1, fk['c2'], fk['c1'], fk['c0'])

    def rhs(t, state):
        E = [eval_perturbation(perts[m], t) for m in range(5)]
        out = [0.0] * 16
        j_sum = 0.0
        for i in range(15):
            eq = equations[i]
            if eq['positive']:
                pos = 1.0
                for k in eq['positive']:
                    idx, c2, c1, c0 = fn_list[k]
                    u = state[idx]
                    pos *= (c2 * u + c1) * u + c0
                if eq['external_positive']:
                    pos *= sum(E[m - 1] for m in eq['external_positive'])
            else:
                pos = 0.0

            if eq['external_subtract']:
                neg = sum(E[m - 1] for m in eq['external_subtract'])
            elif eq['negative']:
                neg = 1.0
                for k in eq['negative']:
                    idx, c2, c1, c0 = fn_list[k]
                    u = state[idx]
                    neg *= (c2 * u + c1) * u + c0
                if eq['external_negative']:
                    neg *= sum(E[m - 1] for m in eq['external_negative'])
            else:
                neg = 0.0

            dx = pos - neg
            xi = state[i]
            if xi <= 0.0 and dx < 0.0:
                dx = 0.0
            elif xi >= 1.0 and dx > 0.0:
                dx = 0.0
            out[i] = dx
            diff = xi - limits[i]
            j_sum += diff * diff
        out[15] = j_sum / 15.0
        return out

    def clamp_state(vec):
        res = vec[:]
        for i in range(15):
            if res[i] < 0.0:
                res[i] = 0.0
            elif res[i] > 1.0:
                res[i] = 1.0
        return res

    t_grid = [round(k * h, 10) for k in range(n + 1)]
    y = list(p['initial']) + [0.0]
    series = [[y[i]] for i in range(15)]
    criterion = [0.0]
    forcing = [[eval_perturbation(perts[m], 0.0)] for m in range(5)]

    for step in range(n):
        t = step * h
        k1 = rhs(t, y)
        y2 = clamp_state([y[j] + 0.5 * h * k1[j] for j in range(16)])
        k2 = rhs(t + 0.5 * h, y2)
        y3 = clamp_state([y[j] + 0.5 * h * k2[j] for j in range(16)])
        k3 = rhs(t + 0.5 * h, y3)
        y4 = clamp_state([y[j] + h * k3[j] for j in range(16)])
        k4 = rhs(t + h, y4)
        y = clamp_state([y[j] + (h / 6.0) * (k1[j] + 2.0 * k2[j] + 2.0 * k3[j] + k4[j]) for j in range(16)])

        t_next = t_grid[step + 1]
        for i in range(15):
            series[i].append(y[i])
        criterion.append(max(0.0, y[15]))
        for m in range(5):
            forcing[m].append(eval_perturbation(perts[m], t_next))

    snap_indices = [0, n // 4, n // 2, (3 * n) // 4, n]
    snapshots = [
        {
            't': t_grid[idx],
            'tau': idx / n,
            'values': [series[i][idx] for i in range(15)],
        }
        for idx in snap_indices
    ]

    public_params = {k: v for k, v in p.items() if k != 'resolved_functions'}
    return {
        'parameters': public_params,
        't': t_grid,
        'series': series,
        'forcing': forcing,
        'criterion': criterion,
        'snapshots': snapshots,
    }


def dispatch(request):
    if not isinstance(request, dict):
        raise InputError('Некорректный запрос.')
    action = request.get('action')
    if action == 'defaults':
        return deepcopy(DEFAULT)
    if action == 'simulate':
        return simulate(request.get('parameters', {}))
    if action == 'experiments':
        p = validate_parameters(request.get('parameters', {}))
        base_params = {k: v for k, v in p.items() if k != 'resolved_functions'}
        cases = [('Текущие условия', None, p['initial'])] + [
            (f'{DATA["years"][idx]} г.', DATA['years'][idx], [round(float(v), 4) for v in DATA['normalized'][idx]])
            for idx in (1, 3, 5, 7)
        ]
        return [
            {
                'name': name,
                'year': year,
                'result': simulate({**base_params, 'initial': init_vals}),
            }
            for name, year, init_vals in cases
        ]
    raise InputError('Неизвестная операция.')


if __name__ == '__main__':
    import sys
    print(json.dumps(dispatch(json.load(sys.stdin)), ensure_ascii=False, allow_nan=False))
