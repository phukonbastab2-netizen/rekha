import fs from 'node:fs';
// The pinned core discards its userDataDir option. Keep the owner's explicitly
// configured browser profile durable at the driver boundary as a second safeguard.
export function withPersistentProfile(driver, directory) {
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  if(process.platform !== 'win32') fs.chmodSync(directory,0o700);
  const launch=driver.launch.bind(driver);
  driver.launch=options=>launch({...options,userDataDir:directory});
  return driver;
}
