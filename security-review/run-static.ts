/** Reproducible OWASP-focused SAST. Run: bun security-review/run-static.ts */
import { chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root=new URL('../',import.meta.url).pathname;
const provenance=await Bun.file(new URL('./static-analysis-provenance.json',import.meta.url)).json();
const directory=join(tmpdir(),'sf-auth-opengrep-'+provenance.tool.version);
await mkdir(directory,{recursive:true});
const executable=join(directory,'opengrep');
if(!await Bun.file(executable).exists()) {
  const response=await fetch(provenance.tool.url);
  if(!response.ok) throw new Error('Unable to download pinned static analyzer');
  await Bun.write(executable,response);
}
const digest=new Bun.CryptoHasher('sha256').update(await Bun.file(executable).arrayBuffer()).digest('hex');
if(digest!==provenance.tool.sha256) throw new Error('Static analyzer checksum mismatch');
await chmod(executable,0o700);
const process=Bun.spawn([executable,'scan','--config','security-review/owasp-community-rules.json',
  '--include','*.ts','--exclude','**/*.test.ts','--disable-nosem','--json','src'],
  {cwd:root,stdout:Bun.file(join(root,'security-review/owasp-static-analysis.json')),stderr:'inherit'});
const status=await process.exited;
if(status!==0) throw new Error('Static analysis failed with exit status '+status);
const report=await Bun.file(join(root,'security-review/owasp-static-analysis.json')).json();
if(report.errors?.length) throw new Error('Static analyzer reported incomplete analysis');
console.log(JSON.stringify({files:report.paths?.scanned?.length,rawFindings:report.results.length,suppressionsEnabled:false}));
