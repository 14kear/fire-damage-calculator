"""Автоматические тесты математической модели системной динамики пожаров (чистый Python 3 unittest)."""
import json
import math
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).parent.resolve()
sys.path.insert(0, str(ROOT))

import model as m  # noqa: E402


class FireDamageModelTests(unittest.TestCase):
    def test_defaults_structure_and_bounds(self):
        d = m.dispatch({'action': 'defaults'})
        self.assertEqual(d['duration'], 1.0)
        self.assertEqual(len(d['initial']), 15)
        self.assertEqual(len(d['limits']), 15)
        self.assertEqual(len(d['perturbations']), 5)
        for v in d['initial']:
            self.assertTrue(0.0 <= v <= 1.0)
        for v in d['limits']:
            self.assertTrue(0.0 <= v <= 1.0)

    def test_all_78_base_functions_loaded_cleanly(self):
        self.assertEqual(len(m.BASE_FUNCTIONS), 78)
        for k in range(1, 79):
            fn = m.BASE_FUNCTIONS[str(k)]
            self.assertEqual(fn['id'], k)
            self.assertTrue(1 <= fn['input'] <= 15)
            self.assertTrue(1 <= fn['target'] <= 15)
            for coef in ('c2', 'c1', 'c0'):
                self.assertTrue(math.isfinite(fn[coef]))
        # Проверка очистки машинного нуля в f72 и f78
        self.assertEqual(m.BASE_FUNCTIONS['72']['c2'], 0.0)
        self.assertEqual(m.BASE_FUNCTIONS['72']['c0'], 0.0)
        self.assertEqual(m.BASE_FUNCTIONS['78']['c2'], 0.0)
        self.assertEqual(m.BASE_FUNCTIONS['78']['c0'], 0.0)

    def test_default_simulation_stays_strictly_in_0_1(self):
        r = m.simulate({})
        self.assertEqual(len(r['t']), 201)
        self.assertEqual(r['t'][0], 0.0)
        self.assertEqual(r['t'][-1], 1.0)
        self.assertEqual(len(r['series']), 15)
        self.assertEqual(len(r['forcing']), 5)
        self.assertEqual(len(r['snapshots']), 5)
        for i in range(15):
            for val in r['series'][i]:
                self.assertTrue(0.0 <= val <= 1.0, f'X{i + 1} вышло за [0, 1]: {val}')
        for idx in range(5):
            for val in r['forcing'][idx]:
                self.assertTrue(0.0 <= val <= 1.0, f'E{idx + 1} вышло за [0, 1]: {val}')
        self.assertGreaterEqual(r['criterion'][-1], 0.0)
        # Сериализация без NaN/Infinity
        encoded = json.dumps(r, allow_nan=False)
        self.assertGreater(len(encoded), 100)

    def test_rejects_values_above_1_or_below_0(self):
        # Начальные условия > 1 или < 0
        with self.assertRaises(m.InputError):
            m.validate_parameters({'initial': [1.01] + [0.5] * 14})
        with self.assertRaises(m.InputError):
            m.validate_parameters({'initial': [-0.01] + [0.5] * 14})

        # Допустимые значения > 1 или < 0
        with self.assertRaises(m.InputError):
            m.validate_parameters({'limits': [1.5] + [0.5] * 14})
        with self.assertRaises(m.InputError):
            m.validate_parameters({'limits': [-0.2] + [0.5] * 14})

        # Интервал T > 1 или <= 0
        with self.assertRaises(m.InputError):
            m.validate_parameters({'duration': 1.2})
        with self.assertRaises(m.InputError):
            m.validate_parameters({'duration': 0.0})

        # Параметры возмущений > 1 или < 0
        bad_perts = [{'a': 0, 'b': 0, 'c': 1.1}] + [{'a': 0, 'b': 0, 'c': 0.2}] * 4
        with self.assertRaises(m.InputError):
            m.validate_parameters({'perturbations': bad_perts})
        neg_perts = [{'a': -0.1, 'b': 0, 'c': 0.2}] + [{'a': 0, 'b': 0, 'c': 0.2}] * 4
        with self.assertRaises(m.InputError):
            m.validate_parameters({'perturbations': neg_perts})

    def test_perturbations_affect_dynamics_physically(self):
        # Увеличение сил пожарной охраны E2 и инструктажей E5 снижает потери X1, X2, X3
        low_safety = [
            {'a': 0.0, 'b': 0.0, 'c': 0.8},  # E1 (АХОВ высокий)
            {'a': 0.0, 'b': 0.0, 'c': 0.05}, # E2 (силы ПО малые)
            {'a': 0.0, 'b': 0.0, 'c': 0.2},
            {'a': 0.0, 'b': 0.0, 'c': 0.2},
            {'a': 0.0, 'b': 0.0, 'c': 0.05}, # E5 (инструктажи малые)
        ]
        high_safety = [
            {'a': 0.0, 'b': 0.0, 'c': 0.2},  # E1 (АХОВ малый)
            {'a': 0.0, 'b': 0.0, 'c': 0.8},  # E2 (силы ПО высокие)
            {'a': 0.0, 'b': 0.0, 'c': 0.2},
            {'a': 0.0, 'b': 0.0, 'c': 0.2},
            {'a': 0.0, 'b': 0.0, 'c': 0.8},  # E5 (инструктажи высокие)
        ]
        init = [0.6] * 15
        r_bad = m.simulate({'initial': init, 'perturbations': low_safety})
        r_good = m.simulate({'initial': init, 'perturbations': high_safety})
        for idx in (0, 1, 2):
            self.assertLess(r_good['series'][idx][-1], r_bad['series'][idx][-1])

    def test_inline_function_coefficients_editing(self):
        init = [0.5] * 15
        # Если f47 (единственная функция в dX9/dt = f47(X5)*(E3+E4)) равна 0, то X9 остаётся постоянным = 0.5
        r = m.simulate({
            'initial': init,
            'functions': {'47': {'c2': 0.0, 'c1': 0.0, 'c0': 0.0}},
        })
        self.assertAlmostEqual(r['series'][8][0], 0.5, places=10)
        self.assertAlmostEqual(r['series'][8][-1], 0.5, places=10)

        # Если f47 = 1.0 и E3+E4 > 0, то X9 возрастает
        r2 = m.simulate({
            'initial': init,
            'functions': {'47': {'c2': 0.0, 'c1': 0.0, 'c0': 1.0}},
        })
        self.assertGreater(r2['series'][8][-1], 0.5)

    def test_series_experiments_fast_and_consistent(self):
        t0 = time.perf_counter()
        init = [0.42] * 15
        res = m.dispatch({
            'action': 'experiments',
            'parameters': {
                'initial': init,
                'duration': 0.8,
                'functions': {'1': {'c2': 0.0, 'c1': 0.0, 'c0': 0.5}},
            },
        })
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        self.assertLess(elapsed_ms, 500.0, f'Серия считается слишком долго: {elapsed_ms:.1f} мс')
        self.assertEqual(len(res), 5)
        self.assertEqual(res[0]['name'], 'Текущие условия')
        self.assertEqual([item['year'] for item in res], [None, 2016, 2018, 2020, 2022])
        self.assertEqual(res[0]['result']['series'][0][0], 0.42)
        for item in res:
            self.assertEqual(item['result']['t'][-1], 0.8)

    def test_normalization_matches_excel_source(self):
        raw = m.DATA['raw']
        scales = m.DATA['scales']
        norm = m.DATA['normalized']
        for col in range(15):
            col_max = max(row[col] for row in raw)
            self.assertAlmostEqual(col_max, scales[col], places=6)
            for r_idx in range(len(raw)):
                self.assertAlmostEqual(norm[r_idx][col] * scales[col], raw[r_idx][col], places=5)


if __name__ == '__main__':
    unittest.main(verbosity=2)
