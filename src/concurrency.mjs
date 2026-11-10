// Tasks read independent snapshots. Results are published only by the caller
// after the whole batch succeeds; a failed batch drains its started requests.
export async function runIndependent(jobs,{signal,limit=2}={}) {
  if(!Array.isArray(jobs)||jobs.some(job=>typeof job!=='function'))throw new TypeError('Independent jobs must be functions.');
  if(!Number.isInteger(limit)||limit<1)throw new RangeError('Concurrency must be a positive integer.');
  signal?.throwIfAborted();
  const controller=new AbortController(),results=new Array(jobs.length);
  let next=0,failed=false,failure;
  function stop(error){
    if(failed)return;
    failed=true;failure=error;controller.abort(error);
  }
  const cancelled=()=>stop(signal.reason);
  signal?.addEventListener('abort',cancelled,{once:true});
  async function worker(){
    while(!failed&&next<jobs.length){
      const index=next++;
      try{results[index]=await jobs[index](controller.signal);}
      catch(error){stop(error);}
    }
  }
  try{
    await Promise.all(Array.from({length:Math.min(limit,jobs.length)},()=>worker()));
    if(failed)throw failure;
    signal?.throwIfAborted();
    return results;
  }finally{signal?.removeEventListener('abort',cancelled);}
}
