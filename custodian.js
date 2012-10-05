#!/usr/bin/env node
/**
 * Custodian
 *
 * Copyright (C) 2011 Bet Smart Media <http://www.betsmartmedia.com>
 *
 * It keeps the things running at the right intervals. But different than cron.
 *
 * With Custodian, you can schedule commands to run at specific intervals (eg,
 * every 30 seconds). You can also schedule commands to run after other
 * commands have completed.
 *
 * Custodian also provides basic watchdog functionality. If a process is not
 * running, it will be restarted.
 */

var util       = require("util");
var cproc      = require("child_process");
var fs         = require("fs");
var daemon     = require("daemon");
var dateFormat = require("dateformat");

var shellParse = require("shell-quote").parse;

var VERSION  = require('./package.json').version;
var mailer   = require("nodemailer").createTransport('sendmail');
var HOSTNAME = require('os').hostname();

if (require.main === module) {
	var log = function (str) {
		var now = dateFormat(new Date, "yyyy-mm-dd HH:MM:ss");
		var msg = "[" + now + "] " + str;
		console.log(msg);
	};
	main()
} else {
	// for unit tests
	var log = function () {}
	exports.run = run;
}

/**
 * This function encapsulate reading/reloading config files and application
 * state then starts up the run loop.
 */
function main () {
	/**
	 * Read and parse config
	 */
	if(process.argv.length < 3) {
		console.error("Usage: node custodian.js <config_file>");
		process.exit(1);
	}

	var CFG_FILE = process.argv[2];

	var CONFIG = {};
	var STATE  = {schedule:{}, watch:{}};

	process.env.IN_CUSTODIAN = 1

	load_config(true);

	// catch SIGHUP and reload config
	process.on('SIGHUP', function() {
		console.log("Caught SIGHUP - reloading configuration");
		load_config();
		init_state();
	});

	/**
	 * Load configuration
	 */
	function load_config (exitOnFailure) {
		try {
			var c = fs.readFileSync(CFG_FILE, "utf8");
			CONFIG = JSON.parse(c);
			if (!CONFIG.schedule) CONFIG.schedule = {}
			if (!CONFIG.watch) CONFIG.watch = {}
		} catch(e) {
			log("Error reading config: " + e);
			if (exitOnFailure) process.exit(1);
		}
	}

	/**
	 * Run as a daemon or as a regular process
	 */
	if (CONFIG.daemon) {
		// become a daemon
		['log','pid'].forEach(function(d) {
			if(!CONFIG[d]) {
				console.error("Error: '"+d+"' directive must be specified when run as a daemon.");
				process.exit(1);
			}
		});

		daemon.daemonize(CONFIG.log, CONFIG.pid, function(err, pid) {
			if(err) {
				console.log("Error starting daemon: " + err);
				process.exit(1);
			}

			process.on('exit', function() {
				fs.unlinkSync(CONFIG.pid);
				process.exit(0);
			});

			run(CONFIG, STATE);
		});
	} else {
		// ... or run as a regular process
		run(CONFIG, STATE);
	}
}


/**
 * Initialize (or re-initialize) state
 */
function init_state (CONFIG, STATE) {
	function clone (o) {
		var c = {};
		for(var x in o) c[x] = o[x];
		return c;
	}

	function reload (type, init) {
		var remove = {};
		for(var name in STATE[type]) remove[name] = true;
		for(var name in CONFIG[type]) {
			delete remove[name];
			var state = STATE[type][name] = STATE[type][name] || clone(init);
			state.env = CONFIG[type][name].env || {};
			state.env.__proto__ = process.env;
		}
		for(var name in remove) delete STATE[type][name];
	}

	reload('schedule', {running: false, last_run: new Date("1980/01/01 00:00:00")});
	reload('watch',    {pid: 0, last_run: 0});
}


/**
 * Main mojo
 */
function run (CONFIG, STATE) {
	log("Custodian v"+VERSION+" starting...");
	init_state(CONFIG, STATE)

	/**
	 * Check on the jobs in CONFIG.watch, restarting those that aren't running, and
	 * killing those that are no longer in the config.
	 */
	function check_watched_jobs () {

		var config_jobs = Object.keys(CONFIG.watch)
			, is_stale = function (name) { return config_jobs.indexOf(name) === -1 }
			, removed_jobs  = Object.keys(STATE.watch).filter(is_stale)

		config_jobs.forEach(function (name) {
			var cfg   = CONFIG.watch[name]
				, state = STATE.watch[name]
				
			// Already running or scheduled to run
			if (state.process || state.timeout) return;

			function restart () {
				// if `rate_limit` is set, don't restart the job more than once
				// every X seconds
				if(CONFIG.rate_limit) {
					var now = (new Date).getTime()
						, rate = CONFIG.rate_limit * 1000
					if(now - state.last_run < rate) {
						log(name+" was started less than "+CONFIG.rate_limit+" seconds ago, deferring");
						state.timeout = setTimeout(restart, (rate + state.last_run) - now)
						return;
					}
				}
				delete state.process
				delete state.timeout
				log(name+" is not running, restarting");
				spawn(name, cfg, state, sendNotification).on('exit', restart);
			};

			restart()
		});

		// Kill any jobs that are no longer in the config but still running.
		removed_jobs.forEach(function (name) {
			if (STATE.watch[name] && STATE.watch[name].pid) process.kill(STATE.watch[name].process.pid)
		});
	}

	/**
	 * Run a scheduled job.  When the job completes, look for other jobs ("sub-jobs")
	 * that should run after this one, and execute them.
	 *
	 * If a sub-job is already running, then it is completely bypassed for this
	 * dispatch cycle.
	 */
	function run_job (name) {
		var state = STATE.schedule[name],
				cfg   = CONFIG.schedule[name];
		if(state.process) return log("... "+name+" is still running, skipping");

		if(cfg.args) cfg.args.forEach(function(it){
			switch(it) {
				case 'last_run': cfg.cmd += ' "' + dateFormat(state.last_run, "yyyy-mm-dd HH:MM:ss") + '"'; break;
				default:         console.log("Unrecognized dyn arg: "+it);
			}
		});

		spawn(name, cfg, state, sendNotification);
		state.process.on('exit', function runAfter (code) {
			delete state.process;
			// TODO - should sub-jobs run after failure?
			// if (code) return

			// find jobs that want to be run after this job, and execute them
			Object.keys(CONFIG.schedule).forEach(function (next_job_name) {
				var next_job = CONFIG.schedule[next_job_name];
				var m = /^after (.*)$/.exec(next_job.when);
				if (!m || m[1] != name) return;
				run_job(next_job_name);
			})
		})
	}

	/**
	 * Send an email notification of an event
	 */
	function sendNotification(kind, name, pid, body) {
		var from = CONFIG.from_email || CONFIG.admin
			, to = CONFIG.notify_email || CONFIG.admin;

		mailer.sendMail({
			to:       to,
			from:     from,
			subject:  'Custodian | Process ' + kind + ' (' + name + ')',
			text:     "Hostname: " + HOSTNAME +
								"\nProcess: " + name +
								"\nPID: "+ pid +
								(body ? "\n\n" + body : ""),
		},
		function (err, success) {
			if (err) log("Failed to send mail to " + to + " " + err)
			else log("Message sent to " + to)
		});
	}

	/**
	 * Check watched jobs and run any scheduled jobs every 5 seconds
	 */
	function dispatch () {
		var now = new Date();

		Object.keys(CONFIG.schedule).forEach(function (x) {
			var m = /^every (.*)([smhd])$/.exec(CONFIG.schedule[x].when);
			if(!m) return;

			switch(m[2]) {
				case 's': var mult = 1;    break;
				case 'm': var mult = 60;   break;
				case 'h': var mult = 3600; break;
				case 'd': var mult = 86400;
			}

			if(STATE.schedule[x].last_run <= new Date(now - (m[1] * mult * 1000))) {
				run_job(x);
			}
		})

		check_watched_jobs();

	}

	var interval = CONFIG.check_interval || 5000
	STATE.interval = setInterval(dispatch, interval);
	dispatch();
}

/**
 * Spawn a new process using the settings in `cfg` and return it.
 */
function spawn(name, cfg, state, sendNotification) {

	if (!cfg.cmd) {
		log('Error: No "cmd" in ' + name + ' cfg: ' + util.format(cfg));
	}

	var args = shellParse(cfg.cmd)
		, cmd = args.shift()
		, cwd = cfg.cwd || process.cwd()

	// Parse args and expand environment variables
	args = args.map(function (arg) { return shellExpand(arg, state.env) });

	// Prepare output redirection
	var stdio = ['ignore']; // No stdin
	if(cfg.output) {
		if (cfg.output !== state.output) {
			// redirect stdout/stderr into the file specified
			// file will be opened in append mode
			if (state.output_fd) fs.closeSync(state.output_fd)
			state.output = cfg.output;
			state.output_fd = fs.openSync(cfg.output, 'a')
		}
		stdio[1] = stdio[2] = state.output_fd;
	} else {
		stdio[1] = stdio[2] = 'ignore';
	}

	var c = state.process = cproc.spawn(cmd, args, {
		env: state.env,
		cwd: cwd,
		stdio: stdio
	});

	log("Started " + name + " (pid: " + c.pid + ")")
	state.last_run = (new Date()).getTime();
	c.on('error', sendNotification.bind(null, "error", name, c.pid))
	c.on('exit', function onExit (code) {
		log(name + ' finished with code ' + code)
		if (state.output_fd) {
			fs.closeSync(state.output_fd);
			delete state.output_fd;
		}
		if (!code) {
			// successful exit
			return
		}
		var body = state.output ? "Output is readable in " + state.ouput : "";
		sendNotification("returned code " + code, name, c.pid, body);
	})
	return c;
}

function shellExpand (string, env) {
	if (string[0] === "'") return string;
	if (!env) env = process.env;
	return string.replace(/\$([A-Za-z0-9_]+)/g, function (m) {
		return env[m.substring(1)] || ''
	})
}
