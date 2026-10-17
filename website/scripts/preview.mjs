import http from 'node:http';
import {readFileSync,existsSync,statSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
const root=resolve('dist'),port=Number(process.env.PORT||4317);
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.ttf':'font/ttf','.txt':'text/plain; charset=utf-8','.xml':'application/xml; charset=utf-8'};
const server=http.createServer((req,res)=>{
 let path;
 try{path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400).end();return;}
 let file=resolve(root,'.'+path);
 if(file!==root&&!file.startsWith(root+sep)){res.writeHead(403).end();return;}
 if(existsSync(file)&&statSync(file).isDirectory()){
  if(!path.endsWith('/')){res.writeHead(308,{Location:path+'/'}).end();return;}
  file=resolve(file,'index.html');
 }
 const found=existsSync(file)&&statSync(file).isFile();
 if(!found)file=resolve(root,'404.html');
 res.writeHead(found?200:404,{'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'});
 if(req.method==='HEAD')res.end();else res.end(readFileSync(file));
});
server.listen(port,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:'+port));
process.once('SIGTERM',()=>server.close());process.once('SIGINT',()=>server.close());
