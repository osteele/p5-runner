import express from 'express';
import { Request, Response } from 'express-serve-static-core';
import fs from 'fs';
import marked from 'marked';
import nunjucks from 'nunjucks';
import { Script, Sketch } from 'p5-analysis';
import path from 'path';
import { createDirectoryListing } from './directory-listing';
import { templateDir } from './globals';
import { createLiveReloadServer, injectLiveReloadScript } from './liveReload';
import WebSocket = require('ws');
import http = require('http');
import { closeSync, listenSync } from './http-server-sync';

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Server {
  export type Options = {
    root: string;
    port: number;
    scanPorts: boolean;
  };
}

type Config = Server.Options & {
  sketchFile?: string;
};

const defaultOptions = { root: '.', port: 3000, scanPorts: true, sketchPath: null };

const jsTemplateEnv = new nunjucks.Environment(null, { autoescape: false });
jsTemplateEnv.addFilter('quote', JSON.stringify);

function createRouter(config: Config): express.Router {
  const router = express.Router();

  router.get('/', (req, res) => {
    const file = config.sketchFile;
    if (file) {
      if (Sketch.isSketchScriptFile(file)) {
        const sketch = Sketch.fromFile(file);
        res.send(injectLiveReloadScript(sketch.getHtmlContent(), req.app.locals.liveReloadServer));
      } else {
        res.sendFile(file);
      }
    } else {
      sendDirectoryListing(config.root, req, res);
    }
  });

  router.get('/*.html?', (req, res, next) => {
    const file = path.join(config.root, req.path);
    try {
      if (req.query.fmt === 'view') {
        res.set('Content-Type', 'text/plain');
        res.sendFile(req.path, { root: config.root });
        return;
      }
      if (req.headers['accept']?.match(/\btext\/html\b/)) {
        const content = fs.readFileSync(file, 'utf-8');
        res.send(injectLiveReloadScript(content, req.app.locals.liveReloadServer));
        return;
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw e;
      }
    }
    next();
  });

  // A request for the HTML of a JavaScript file returns HTML that includes the sketch.
  // A request for the HTML of a main sketch js file redirects to the sketch's index page.
  router.get('/*.js', (req, res, next) => {
    const file = path.join(config.root, req.path);
    if (req.headers['accept']?.match(/\btext\/html\b/) && req.query.fmt !== 'view' && Sketch.isSketchScriptFile(file)) {
      const { sketches } = Sketch.analyzeDirectory(path.dirname(file));
      const sketch = sketches.find(sketch => sketch.files.includes(path.basename(file)));
      if (sketch) {
        const content = sketch.getHtmlContent();
        res.send(injectLiveReloadScript(content, req.app.locals.liveReloadServer));
        return;
      }
    }
    try {
      const errs = Script.fromFile(file).getErrors();
      if (errs.length) {
        const template = fs.readFileSync(path.join(templateDir, 'report-syntax-error.js.njk'), 'utf8');
        return res.send(
          jsTemplateEnv.renderString(template, {
            fileName: path.basename(errs[0].fileName!), // TODO: relative to referer
            message: errs[0].message
          })
        );
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw e;
      }
    }
    next();
  });

  router.get('/*.md', (req, res, next) => {
    if (req.headers['accept']?.match(/\btext\/html\b/)) {
      const file = path.join(config.root, req.path);
      if (!fs.existsSync(file)) {
        return next();
      }
      const fileData = fs.readFileSync(file, 'utf-8');
      res.send(marked(fileData));
    }
    return next();
  });

  router.get('*', (req, res, next) => {
    if (req.headers['accept']?.match(/\btext\/html\b/)) {
      const file = path.join(config.root, req.path);
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
        sendDirectoryListing(config.root, req, res);
        return;
      }
    }
    next();
  });

  return router;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sendDirectoryListing(root: string, req: Request<any, any, any, any, any>, res: Response<any, any>) {
  const relPath = req.path;
  let fileData: string;
  let isSingleSketch = false;
  try {
    const absPath = path.join(root, relPath);
    fileData = fs.readFileSync(path.join(absPath, 'index.html'), 'utf-8');
    isSingleSketch = true;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e;
    }
    fileData = createDirectoryListing(relPath, root);
  }

  if (isSingleSketch && !relPath.endsWith('/')) {
    res.redirect(relPath + '/');
    return;
  }

  // Note:  this injects the reload script into the generated index pages too.
  // This is helpful when the directory contents change.
  res.send(injectLiveReloadScript(fileData, req.app.locals.liveReloadServer));
}

async function startServer(options: Partial<Server.Options>) {
  const config: Config = { ...defaultOptions, ...options };
  if (!fs.statSync(config.root).isDirectory()) {
    config.sketchFile = config.root;
    config.root = path.dirname(config.root);
  }
  const { root, port } = config;

  const app = express();
  app.use('/__p5_server_static', express.static(path.join(__dirname, 'static')));
  app.use(createRouter(config));
  app.use('/', express.static(root));

  // For effect only. This provide errors and diagnostics before waiting for a
  // browser request.
  if (fs.statSync(root).isDirectory()) {
    createDirectoryListing('/', root);
  }

  let server: http.Server | null = null;
  for (let p = port; p < port + 10; p++) {
    try {
      server = await listenSync(app, p);
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE' || !config.scanPorts) {
        throw e;
      }
      console.log(`Port ${p} is in use, retrying...`);
    }
  }
  if (!server) {
    server = await listenSync(app);
  }

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start server 1');
  }
  try {
    const liveReloadServer = createLiveReloadServer(root);
    app.locals.liveReloadServer = liveReloadServer;
    const url = `http://localhost:${address.port}`;
    return { server, liveReloadServer, url };
  } catch (e) {
    server.close();
    throw e;
  }
}

/** Server is a web server with live reload, sketch-aware directory listings,
 * and library inference for JavaScript-only sketches.
 */
export class Server {
  public server: http.Server | null = null;
  public url?: string;
  protected liveReloadServer: WebSocket.Server | null = null;
  private readonly options: Partial<Server.Options>;

  constructor(options: Partial<Server.Options> = {}) {
    this.options = options;
  }

  static async start(options: Partial<Server.Options> = {}) {
    return new Server(options).start();
  }

  async start() {
    const { server, liveReloadServer, url } = await startServer(this.options);
    this.server = server;
    this.liveReloadServer = liveReloadServer;
    this.url = url;
    return this;
  }

  async stop() {
    if (this.server) {
      await closeSync(this.server);
    }
    this.server = null;
    this.liveReloadServer?.close();
    this.liveReloadServer = null;
    this.url = undefined;
  }
}
