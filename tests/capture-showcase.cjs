
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400,
    height: 980,
    show: false,
    webPreferences: {
      offscreen: true
    }
  });

  const targetPath = path.resolve(__dirname, 'koi-canvas-showcase.html');
  await win.loadURL('file://' + targetPath);
  
  // Wait for canvas rendering
  await new Promise(r => setTimeout(r, 600));

  const image = await win.capturePage();
  fs.writeFileSync(path.resolve(__dirname, 'koi-morphology-showcase.png'), image.toPNG());
  console.log('CAPTURE_SUCCESS');
  app.quit();
});
