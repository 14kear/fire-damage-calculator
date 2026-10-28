import sys, math, unittest
from pathlib import Path
import numpy as np
ROOT=Path(__file__).parent
sys.path.insert(0,str(ROOT/'site' if (ROOT/'site').is_dir() else ROOT))
import model as m

class ModelTests(unittest.TestCase):
    def test_missing_external_data_is_not_filled(self):
        with self.assertRaises(m.InputError): m.simulate({})
    def test_exact_source_signs_and_external_groups(self):
        p=m.parameters({'forcing':['2','3','5','7','11'],'polynomials':['1']*78})
        rhs,_=m.prepare(p)
        np.testing.assert_allclose(rhs(0,np.r_[p['initial'],0])[:15],[-12,-12,-1,-4,6,1,11,6,12,7,-4,1,7,-9,1])
    def test_known_f7_regression(self):
        p=m.fit_coefficients()[6]
        np.testing.assert_allclose(p['coefficients'],[.7910939134302122,.373946742672281,-.420939918485693],rtol=1e-11)
        self.assertAlmostEqual(p['r2'],.30153274419638676,places=12)
    def test_normalization_and_inverse(self):
        raw=np.array(m.DATA['raw']);scales=np.array(m.DATA['scales'])
        np.testing.assert_allclose(raw.max(axis=0),scales)
        np.testing.assert_allclose(np.array(m.DATA['normalized'])*scales,raw)
    def test_rk4_against_analytic_and_order(self):
        rhs=lambda t,y:-y
        _,a=m.rk4(rhs,[1.],1.,20);_,b=m.rk4(rhs,[1.],1.,40)
        e1=abs(a[0,-1]-math.exp(-1));e2=abs(b[0,-1]-math.exp(-1))
        self.assertGreater(e1/e2,15);self.assertLess(e1/e2,18)
    def test_full_solver_criterion_and_rk45_agree(self):
        p={'forcing':['0']*5,'plus':['0']*15,'minus':[f'x{i+1}' for i in range(15)],'initial':[1]*15,'target':[0]*15}
        a=m.simulate(p);b=m.simulate({**p,'method':'RK45'})
        self.assertAlmostEqual(a['series'][0][-1],math.exp(-.7),places=10)
        self.assertAlmostEqual(a['criterion'][-1],(1-math.exp(-1.4))/2,places=10)
        np.testing.assert_allclose(a['series'],b['series'],atol=1e-9)
    def test_negative_state_is_reported_not_clipped(self):
        a=m.simulate({'forcing':['0']*5})
        self.assertIn(8,a['diagnostics']['negative'])
        self.assertLess(a['series'][7][-1],-.02)
        self.assertAlmostEqual(a['series'][14][-1],math.exp(-.7),places=10)
    def test_series_uses_current_equations_factors_and_observed_states(self):
        r=m.dispatch({'action':'experiments','parameters':{'forcing':['t']*5,'plus':['0']*15,'minus':['0']*15}})
        self.assertEqual([q['year'] for q in r],[2015,2016,2018,2020,2022])
        for q,i in zip(r,[0,1,3,5,7]):
            np.testing.assert_allclose(np.array(q['result']['series'])[:,-1],m.DATA['normalized'][i])
            self.assertAlmostEqual(q['result']['forcing'][0][-1],.7)
    def test_arbitrary_code_and_invalid_math_rejected(self):
        for s in ['__import__("os")','u.__class__','[u][0]','(lambda: 1)()','10**1000','1/0','sqrt(-1)']:
            with self.subTest(s=s):
                with self.assertRaises(m.InputError):m.Expression(s,{'u'},'test')({'u':1})
    def test_dimensions_and_step_grid(self):
        for p in [{'initial':[1]},{'steps':201},{'duration':0},{'weights':[0]*15}]:
            with self.assertRaises(m.InputError):m.parameters(p)
    def test_external_controls_have_expected_effect(self):
        p=m.parameters({'forcing':['0','0','0','0','0']});rhs,_=m.prepare(p)
        a=rhs(0,np.r_[p['initial'],0]);p['forcing'][1]='.1';rhs,_=m.prepare(p)
        b=rhs(0,np.r_[p['initial'],0]);np.testing.assert_allclose((b-a)[:3],[-.1]*3)
        np.testing.assert_allclose((b-a)[3:],0)

if __name__=='__main__':unittest.main(verbosity=2)
