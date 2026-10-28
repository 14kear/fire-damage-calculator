let ready;
async function initialize(){
 self.postMessage({status:'Загрузка Python… При первом запуске это может занять около минуты.'});
 importScripts('https://cdn.jsdelivr.net/pyodide/v0.29.2/full/pyodide.js');
 const py=await loadPyodide({indexURL:'https://cdn.jsdelivr.net/pyodide/v0.29.2/full/'});
 self.postMessage({status:'Загрузка библиотеки SciPy…'});
 await py.loadPackage('scipy');
 const response=await fetch('./model.py?v=numeric-20261028');if(!response.ok)throw Error('Не удалось загрузить модель.');
 const dataset=await fetch('./source_data.json?v=numeric-20261028');if(!dataset.ok)throw Error('Не удалось загрузить статистику.');
 py.FS.writeFile('/source_data.json',await dataset.text());
 const source=await response.text();py.globals.set('__name__','putilov_model');py.globals.set('__file__','/model.py');py.runPython(source,{filename:'putilov_model.py'});
 return py;
}
self.onmessage=async({data})=>{
 try{
  ready??=initialize().catch(error=>{ready=null;throw error;});const py=await ready;
  py.globals.set('_request_json',JSON.stringify(data.request));
  const response=JSON.parse(py.runPython(`
try:
    _response = {'result': dispatch(json.loads(_request_json))}
except Exception as error:
    _response = {'error': str(error)}
json.dumps(_response, ensure_ascii=False, allow_nan=False)
`));
  self.postMessage({id:data.id,...response});
 }catch(e){self.postMessage({id:data.id,error:'Расчёт не выполнен: '+e.message});}
};
