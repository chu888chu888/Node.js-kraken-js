'use strict';

var http = require('http'),
    path = require('path'),
    nconf = require('nconf'),
    domain = require('domain'),
    express = require('express'),
    //i18n = require('webcore-i18n'),
    enrouten = require('express-enrouten'),
    middleware = require('./lib/middleware'),
    pathutil = require('./lib/util/pathutil'),
    configutil = require('./lib/util/configutil');

var appcore = require('./lib/appcore');

if (path.dirname(require.main.filename) !== process.cwd()) {
    console.warn('WARNING: Process not started from application root.');
    console.warn('Current directory:', process.cwd());
    console.warn('Application root:', path.dirname(require.main.filename));
}


// Deps
// Peer
// - enrouten?
// - express-dustjs?
// - express?
//
// Peer Dev (untracked)
// - LESS
// - consolidate
// - Jade (Testing only)
// - r.js
//
// Self
// - webcore-appsec
// - express-winston?
// - nconf
//
// Self Dev
// - Mocha
// - chai
// - webcore-devtools




function AppCore(delegate) {
    this._delegate = delegate || {};
    this._application = express();
    this._server = null;
    this._config = null;
}

AppCore.prototype = {

    init: function (callback) {
        this._configure(callback);
    },


    start: function (callback) {
        var port, host;

        port = configutil.getPort(this._config);
        host = configutil.getHost(this._config);

        this._server = this._application.listen(port, host, function () {
            callback(null, port);
        });
    },


    stop: function (callback) {
        this._server.once('close', callback);
        this._server.close();
    },


    _configure: function (callback) {
        var that, app;

        that = this;
        app  = this._application;

        configutil.load(nconf);

        function next(err, config) {
            var agentSettings;

            if (err) {
                callback(err);
                return;
            }

            // Make global agent maxSocket setting configurable
            agentSettings = config.get('globalAgent');
            http.globalAgent.maxSockets = agentSettings && agentSettings.maxSockets ? agentSettings.maxSockets : Infinity;

            app.disable('x-powered-by');
            app.set('env', config.get('env:env'));

            that._config = config;
            that._views();
            that._middleware();
            callback();
        }

        if (typeof this._delegate.configure === 'function') {
            if (this._delegate.configure.length > 1) {
                this._delegate.configure(nconf, next);
                return;
            }

            this._delegate.configure(nconf);
        }

        next(null, nconf);
    },


    _views: function () {
        var viewEngineConfig, i18nConfig, engine, renderer, app;

        // API for view renderer can either be module.name or module.name(config)
        // Supports 'consolidate' as well as express-dustjs.
        viewEngineConfig = this._config.get('viewEngine');
        engine = require(viewEngineConfig.module);
        renderer = engine[viewEngineConfig.ext];

        i18nConfig = this._config.get('i18n');
        if (i18nConfig && viewEngineConfig.cache) {
            // If i18n is enabled, disable view renderer cache
            // and use i18n internal cache.
            i18nConfig.cache = viewEngineConfig.cache;
            viewEngineConfig.cache = !viewEngineConfig.cache;
        }

        // Assume a single argument renderer means it's actually a factory
        // method and needs to be configured.
        if (typeof renderer === 'function' && renderer.length === 1) {
            // Now create the real renderer
            renderer = renderer(viewEngineConfig);
        }

        app = this._application;
        app.engine(viewEngineConfig.ext, renderer);
        app.set('view engine', viewEngineConfig.ext);
        app.set('view cache', false);
        app.set('views', pathutil.resolve(viewEngineConfig.templatePath));

        if (i18nConfig) {
            var dusti18n = tryRequire('dustjs-i18n');
            if (dusti18n) {
                i18nConfig.contentPath = pathutil.resolve(i18nConfig.contentPath);
                var i18n = dusti18n.create(i18nConfig);
                i18n.create(app, i18nConfig);
            }
        }
    },


    _middleware: function () {
        var app, delegate, settings, srcRoot, staticRoot;

        app = this._application;
        delegate = this._delegate;
        settings = this._config.get('middleware');
        srcRoot = pathutil.resolve(settings.static.srcRoot);
        staticRoot = pathutil.resolve(settings.static.rootPath);

        app.use(express.favicon());
        // app.use(middleware.domain()); // TODO: This hangs for some reason. Investigate.
        app.use(middleware.compiler(srcRoot, staticRoot, this._config));
        app.use(express.static(staticRoot));
        app.use(middleware.logger(settings.logger));

        if (typeof delegate.requestStart === 'function') {
            delegate.requestStart(app); // TODO: Pass facade, not *real* server?
        }

        app.use(express.bodyParser(settings.bodyParser || { limit: 2097152 })); // default to 2mb limit
        app.use(express.cookieParser(settings.session.secret));
        app.use(middleware.session(settings.session));
        app.use(middleware.appsec(settings.appsec));

        if (typeof delegate.requestBeforeRoute === 'function') {
            delegate.requestBeforeRoute(app); // TODO: Pass facade, not *real* server?
        }

        enrouten(app).withRoutes({
            directory: pathutil.resolve(this._config.get('routes:routePath'))
        });

        if (typeof delegate.requestAfterRoute === 'function') {
            delegate.requestAfterRoute(app); // TODO: Pass facade, not *real* server?
        }

        app.use(middleware.errorHandler(settings.errorHandler));

        // TODO: Optional requestError?
        // TODO: Optional requestEnd?
    }

};


var application;

exports.start = function (delegate, callback) {
    if (typeof delegate === 'function') {
        callback = delegate;
        delegate = undefined;
    }

    var app = new AppCore(delegate);
    app.init(function (err) {
        if (err) {
            callback(err);
            return;
        }
        application = app;
        application.start(callback);
    });
};

exports.stop = function (callback) {
    if (!application) {
        callback(new Error('Application not initialized.'));
        return;
    }

    application.stop(function () {
        application = undefined;
        callback();
    });
};

