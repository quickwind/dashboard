// Copyright 2015 Google Inc. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Gulp tasks that serve the application.
 */
import browserSync from 'browser-sync';
import browserSyncSpa from 'browser-sync-spa';
import child from 'child_process';
import gulp from 'gulp';
import proxyMiddleware from 'http-proxy-middleware';
import path from 'path';
import conf from './conf';

/**
 * Browser sync instance that serves the application.
 */
export const browserSyncInstance = browserSync.create();

/**
 * Currently running backend process object. Null if the backend is not running.
 *
 * @type {?child.ChildProcess}
 */
let runningBackendProcess = null;

/**
 * Builds array of arguments for backend process based on env variables and prod/dev mode.
 *
 * @param {string} mode
 * @return {!Array<string>}
 */
function getBackendArgs(mode) {
  let args = [
    `--heapster-host=${conf.backend.heapsterServerHost}`,
    `--tls-cert-file=${conf.backend.tlsCert}`,
    `--tls-key-file=${conf.backend.tlsKey}`,
  ];

  if (mode === conf.backend.production) {
    args.push(`--insecure-port=${conf.frontend.serverPort}`);
  }

  if (mode === conf.backend.development) {
    args.push(`--insecure-port=${conf.backend.devServerPort}`);
  }

  if (conf.backend.envKubeconfig) {
    args.push(`--kubeconfig=${conf.backend.envKubeconfig}`);
  } else {
    args.push(`--apiserver-host=${conf.backend.envApiServerHost || conf.backend.apiServerHost}`);
  }

  return args;
}

/**
 * Initializes BrowserSync tool. Files are served from baseDir directory list and all API calls
 * are proxied to a running backend instance. When includeBowerComponents is true, requests for
 * paths starting with '/bower_components' are routed to bower components directory.
 *
 * HTTP/HTTPS is served on 9090 when using `gulp serve`.
 *
 * @param {!Array<string>|string} baseDir
 * @param {boolean} includeBowerComponents
 */
function browserSyncInit(baseDir, includeBowerComponents) {
  // Enable custom support for Angular apps, e.g., history management.
  browserSyncInstance.use(browserSyncSpa({
    selector: '[ng-app]',
  }));

  let apiRoute = '/api';
  let proxyMiddlewareOptions = {
    target: conf.frontend.serveHttps ? `https://localhost:${conf.backend.secureDevServerPort}` :
                                       `http://localhost:${conf.backend.devServerPort}`,
    changeOrigin: true,
    ws: true,  // Proxy websockets.
    secure: false,
  };

  let config = {
    browser: [],       // Needed so that the browser does not auto-launch.
    directory: false,  // Disable directory listings.
    server: {
      baseDir: baseDir,
      middleware: proxyMiddleware(apiRoute, proxyMiddlewareOptions),
    },
    port: conf.frontend.serverPort,
    https: conf.frontend.serveHttps,  // Will serve only on HTTPS if flag is set.
    startPath: '/',
    notify: false,
  };

  if (includeBowerComponents) {
    config.server.routes = {
      '/bower_components': conf.paths.bowerComponents,
    };
  }

  browserSyncInstance.init(config);
}

/**
 * Serves the application in development mode.
 */
function serveDevelopmentMode() {
  browserSyncInit(
      [
        conf.paths.serve,
        conf.paths.app,  // For assets to work.
      ],
      true);
}

/**
 * Serves the application in development mode. Watches for changes in the source files to rebuild
 * development artifacts.
 */
gulp.task('serve', ['spawn-backend', 'watch'], serveDevelopmentMode);

/**
 * Serves the application in development mode.
 */
gulp.task('serve:nowatch', ['spawn-backend', 'index'], serveDevelopmentMode);

/**
 * Serves the application in production mode.
 */
gulp.task('serve:prod', ['spawn-backend:prod']);

/**
 * Spawns new backend application process and finishes the task immediately. Previously spawned
 * backend process is killed beforehand, if any. The frontend pages are served by BrowserSync.
 */
gulp.task('spawn-backend', ['backend', 'kill-backend', 'locales-for-backend:dev'], function() {
  runningBackendProcess = child.spawn(
      path.join(conf.paths.serve, conf.backend.binaryName),
      getBackendArgs(conf.backend.development), {stdio: 'inherit', cwd: conf.paths.serve});

  runningBackendProcess.on('exit', function() {
    // Mark that there is no backend process running anymore.
    runningBackendProcess = null;
  });
});

/**
 * Spawns new backend application process and finishes the task immediately. Previously spawned
 * backend process is killed beforehand, if any. In production the backend does serve the frontend
 * pages as well.
 */
gulp.task('spawn-backend:prod', ['build-frontend', 'backend:prod', 'kill-backend'], function() {
  runningBackendProcess = child.spawn(
      path.join(conf.paths.dist, conf.backend.binaryName), getBackendArgs(conf.backend.production),
      {stdio: 'inherit', cwd: conf.paths.dist});

  runningBackendProcess.on('exit', function() {
    // Mark that there is no backend process running anymore.
    runningBackendProcess = null;
  });
});

/**
 * Copies the locales configuration to the serve directory.
 * In development, this configuration plays no significant role and serves as a stub.
 */
gulp.task('locales-for-backend:dev', function() {
  return gulp.src(path.join(conf.paths.base, 'i18n', '*.json')).pipe(gulp.dest(conf.paths.serve));
});

/**
 * Kills running backend process (if any).
 */
gulp.task('kill-backend', function(doneFn) {
  if (runningBackendProcess) {
    runningBackendProcess.on('exit', function() {
      // Mark that there is no backend process running anymore.
      runningBackendProcess = null;
      // Finish the task only when the backend is actually killed.
      doneFn();
    });
    runningBackendProcess.kill();
  } else {
    doneFn();
  }
});

/**
 * Watches for changes in source files and runs Gulp tasks to rebuild them.
 */
gulp.task('watch', ['index', 'angular-templates'], function() {
  gulp.watch([path.join(conf.paths.frontendSrc, 'index.html'), 'bower.json'], ['index']);

  gulp.watch(
      [
        path.join(conf.paths.frontendSrc, '**/*.scss'),
      ],
      function(event) {
        if (event.type === 'changed') {
          // If this is a file change, rebuild only styles - nothing more is needed.
          gulp.start('styles');
        } else {
          // If this is new/deleted file, everything has to be rebuilt.
          gulp.start('index');
        }
      });

  gulp.watch(path.join(conf.paths.frontendSrc, '**/*.js'), ['scripts-watch']);
  gulp.watch(path.join(conf.paths.frontendSrc, '**/*.html'), ['angular-templates']);
  gulp.watch(path.join(conf.paths.backendSrc, '**/*.go'), ['spawn-backend']);
});
