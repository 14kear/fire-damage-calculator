import sys,math,unittest
from pathlib import Path
import numpy as np
ROOT=Path(__file__).parent
sys.path.insert(0,str(ROOT/'site' if (ROOT/'site').is_dir() else ROOT))
import model as m

class ModelTests(unittest.TestCase):
    def test_complete_article_example_requires_only_numbers(self):
        r=m.simulate({})
        self.assertEqual(r['parameters']['initial'],m.DATA['article_initial'])
        self.assertEqual(r['forcing'],[])
        self.assertEqual(r['parameters']['external_start'],[])
        np.testing.assert_allclose([r['series'][i][-1] for i in [0,1,2,8]],[1.398636244496,1.463543803775,1.129550082403,.804545343336],atol=2e-10,rtol=0)
        self.assertAlmostEqual(r['criterion'][-1],.09306763004434,places=10)
    def test_literal_x9_derivative_matches_printed_polynomial(self):
        p=m.parameters({});rhs,_=m.prepare(p)
        self.assertAlmostEqual(rhs(0,np.r_[p['initial'],0])[8],.791+.374*.609-.421*.609**2,places=13)
    def test_full_model_does_not_invent_missing_factors(self):
        with self.assertRaises(m.InputError):m.simulate({'model':'full'})
        with self.assertRaises(m.InputError):m.simulate({'model':'full','external_start':['0']*5,'external_slope':['']*5})
    def test_external_parameters_are_numbers_and_affine(self):
        p=m.parameters({'model':'full','external_start':[.1,.2,.3,.4,.5],'external_slope':[.1,-.2,.3,0,-.1]})
        _,f=m.prepare(p);np.testing.assert_allclose(f(.7),[.17,.06,.51,.4,.43])
        with self.assertRaises(m.InputError):m.parameters({'model':'full','external_start':['2*t']*5,'external_slope':[0]*5})
        with self.assertRaises(m.InputError):m.parameters({'model':'full','external_start':[0]*5,'external_slope':[-1]*5})
    def test_external_brigade_factor_changes_only_expected_derivatives(self):
        p=m.parameters({'model':'full','external_start':[0]*5,'external_slope':[0]*5});a,_=m.prepare(p)
        p2={**p,'external_start':[0,.1,0,0,0]};b,_=m.prepare(p2);y=np.r_[p['initial'],0]
        np.testing.assert_allclose((b(0,y)-a(0,y))[:3],[-.1]*3)
        np.testing.assert_allclose((b(0,y)-a(0,y))[3:],0)
    def test_source_versions_are_not_silently_equated(self):
        a=m.simulate({});b=m.simulate({'model':'full','external_start':[0]*5,'external_slope':[0]*5})
        self.assertGreater(abs(a['series'][8][-1]-b['series'][8][-1]),.5)
        self.assertIn(8,b['diagnostics']['negative']);self.assertLess(b['series'][7][-1],0)
    def test_regression_is_reproducible(self):
        p=m.fit_coefficients()[6]
        np.testing.assert_allclose(p['coefficients'],[.7910939134302122,.373946742672281,-.420939918485693],rtol=1e-11)
        self.assertAlmostEqual(p['r2'],.30153274419638676,places=12)
    def test_normalization_units(self):
        raw=np.array(m.DATA['raw']);scales=np.array(m.DATA['scales'])
        np.testing.assert_allclose(raw.max(axis=0),scales)
        np.testing.assert_allclose(np.array(m.DATA['normalized'])*scales,raw)
    def test_rk4_order_on_known_solution(self):
        _,a=m.rk4(lambda t,y:-y,[1.],1.,20);_,b=m.rk4(lambda t,y:-y,[1.],1.,40)
        ratio=abs(a[0,-1]-math.exp(-1))/abs(b[0,-1]-math.exp(-1))
        self.assertGreater(ratio,15);self.assertLess(ratio,18)
    def test_two_solvers_and_refinement_agree(self):
        a=m.simulate({});b=m.simulate({'method':'RK45'})
        np.testing.assert_allclose(a['series'],b['series'],atol=2e-8,rtol=0)
        self.assertAlmostEqual(a['criterion'][-1],b['criterion'][-1],places=9)
        self.assertLess(a['diagnostics']['step_difference'],1e-9)
    def test_experiments_include_current_input_and_keep_settings(self):
        initial=m.DATA['article_initial'].copy();initial[0]=.7
        r=m.dispatch({'action':'experiments','parameters':{'initial':initial,'duration':.4}})
        self.assertEqual(r[0]['name'],'Текущие значения')
        self.assertEqual([q['year'] for q in r],[None,2016,2018,2020,2022])
        self.assertEqual(r[0]['result']['series'][0][0],.7)
        for q in r:self.assertEqual(q['result']['t'][-1],.4);self.assertEqual(q['result']['parameters']['model'],'article')
    def test_invalid_inputs_are_rejected(self):
        for p in [{'initial':[1]},{'steps':201},{'duration':0},{'weights':[0]*15},{'model':'unknown'},{'duration':'1+1'}]:
            with self.subTest(p=p):
                with self.assertRaises(m.InputError):m.parameters(p)
    def test_no_code_execution_in_arithmetic_parser(self):
        for s in ['__import__("os")','u.__class__','[u][0]','10**1000','1/0']:
            with self.subTest(s=s):
                with self.assertRaises(m.InputError):m.Expression(s,{'u'},'test')({'u':1})

class EditorTests(unittest.TestCase):
    def test_all_article_functions_preserve_source_rhs(self):
        for values in [[.1]*15,[.5]*15,[1]*15,np.linspace(.1,.9,15).tolist(),m.DATA['article_initial']]:
            p=m.parameters({'initial':values});rhs,_=m.prepare(p)
            expected=[m.Expression(s,{f'x{i}' for i in range(1,16)},'source')({f'x{i}':values[i-1] for i in range(1,16)}) for s in m.ARTICLE]
            np.testing.assert_allclose(rhs(0,np.r_[p['initial'],0])[:15],expected,atol=1e-12,rtol=1e-10)
    def test_edit_affects_only_its_equation_derivative(self):
        p=m.parameters({});a,_=m.prepare(p);b,_=m.prepare(m.parameters({'functions':{'1':{'kind':'constant','a':0}}}))
        y=np.r_[p['initial'],0];self.assertEqual(b(0,y)[0],0);np.testing.assert_allclose(a(0,y)[1:],b(0,y)[1:])
    def test_preview_and_calculation_use_same_custom_function(self):
        spec={'kind':'custom','expression':'0.5 + sin(u)'}
        r=m.preview({'function_id':'1','function':spec})
        self.assertAlmostEqual(r['values'][-1],.5+math.sin(1))
        p=m.parameters({'functions':{'1':spec}});rhs,_=m.prepare(p);self.assertTrue(np.isfinite(rhs(0,np.r_[p['initial'],0])).all())
    def test_edits_survive_experiment_series(self):
        spec={'1':{'kind':'constant','a':0}}
        r=m.dispatch({'action':'experiments','parameters':{'functions':spec}})
        for q in r:self.assertAlmostEqual(q['result']['series'][0][0],q['result']['series'][0][-1])
    def test_normalized_inputs_and_targets_reject_outside_range(self):
        for key in ['initial','target','weights']:
            with self.assertRaises(m.InputError):m.parameters({key:[1.01]*15})
    def test_custom_expression_rejects_unsafe_or_undefined(self):
        for source in ['__import__("os")','u.__class__','1/(u-0.5)','log(u)']:
            with self.assertRaises(m.InputError):m.preview({'function':{'kind':'custom','expression':source}})
    def test_function_forms(self):
        for kind,answer in [('quadratic',6),('linear',3),('constant',1),('exponential',math.exp(2)+3)]:
            r=m.preview({'function':{'kind':kind,'a':1,'b':2,'c':3}});self.assertAlmostEqual(r['values'][-1],answer)
    def test_normalized_external_endpoints(self):
        with self.assertRaises(m.InputError):m.parameters({'model':'full','external_start':[1]*5,'external_slope':[.1]*5})

if __name__=='__main__':unittest.main(verbosity=2)
