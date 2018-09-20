var pages = require('webpage');
var server = require('webserver').create();
var _ = require('lodash');
var CryptoJS = require('crypto-js');
var fs = require('fs');
var execFile = require("child_process").execFile;
var args = require('system').args;

var DEFAULTS = require( './defaults.json' );

var system = require( 'system' );
var PHANTOMJS_MESSAGE_STARTER = '*!*!*!*!STARTING PHANTOMJS MESSAGE!*!*!*!*';
var PHANTOMJS_MESSAGE_ENDER = '*!*!*!*!ENDING PHANTOMJS MESSAGE!*!*!*!*';

var oldConsole = console;
var job = {};
console = {
	sendMessage: function ( msg ) {
		oldConsole.log( PHANTOMJS_MESSAGE_STARTER );
		oldConsole.log( JSON.stringify( msg ) );
		oldConsole.log( PHANTOMJS_MESSAGE_ENDER );
	},
	buildString: function ( strings ) {
		return _.map( strings, function ( s ) {
			if ( typeof s === 'object' ) {
				return JSON.stringify( s );
			} else {
				return s;
			}
		}).join( ' ' );
	},
	log: function ( ) {
		this.sendMessage( { log: job.req + ": " + this.buildString( Array.prototype.slice.apply( arguments ) ) } );
	},
	error: function ( ) {
		this.sendMessage( { error: job.req + ": " + this.buildString( Array.prototype.slice.apply( arguments ) ) } );
	},
	sendResult: function ( result ) {
		this.sendMessage( { result: result } );
		phantom.exit( );
	}
};

/******************************\
*            SERVER            *
\******************************/

function getStackTrace( msg, trace )
{
	var stack = [ msg ];
	if ( trace ) {
		if ( _.isArray( trace ) ) {
			stack.push( '\tTRACE:' );
			_.forEach(trace, function(t) {
				stack.push('\t\t-> '+t.file+': '+t.line+(t.function ? ' (in function "'+t.function+'")':''));
			})
		} else if ( typeof trace === 'string' ) {
			stack.push( '\tTRACE:' );
			_.each( trace.split( '\n' ), function ( line ) {
				stack.push( '\t\t-> '+line );
			});
		}
	}
	return stack.join( '\n' );
}

phantom.onError = function phantomError ( msg, trace )
{
	// console.log( '!!! got error' );
	console.error( getStackTrace( msg, trace ) );
};

function checkOutput( page, end )
{
	var hasResult = page.evaluate( function( ) {
		return {
			noResult: typeof phantom.output !== 'undefined' && phantom.output === null,
			result: typeof phantom.output !== 'undefined',
			failure: typeof phantom.failure !== 'undefined'
		};
	});
	if ( !hasResult ) {
		console.error( 'Error checking for liveScrape output', page );
		console.sendResult( { error: 'Error checking for output' } );
	} else if ( hasResult.failure ) {
		console.log( 'Found liveScrape output error' );
		var output = page.evaluate( function( ) {
			return phantom.failure;
		});
		console.sendResult( { failure: output } );
	} else if ( hasResult.noResult ) {
		console.log( 'liveScrape submitted: no result' );
		console.sendResult( { success: null } );
	} else if ( hasResult.result ) {
		console.log( 'Found submitted output' );
		var output = page.evaluate( function( ) {
			return phantom.output;
		});
		console.sendResult( { success: output } );
	} else {
		setTimeout( function( ) {
			// Make sure page hasn't timed out
			// Blame Qt for this monstrosity, apparently
			if ( page+'' !== 'null' ) {
				checkOutput( page, end );
			}
		}, 500);
	}
}

function processPage( page, params )
{
	page.evaluate( function( ) {
		liveScrape = phantom = {
			submit: function ( val )
			{
				phantom.output = JSON.stringify( val );
			},
			fail: function ( msg, code )
			{
				phantom.failure = msg || 'GENERIC_FAILURE';
			},
			noResult: function ( )
			{
				phantom.output = null;
			},
			waitFor: function ( args )
			{
				if ( typeof args !== 'object'
					|| ( typeof args.condition !== 'function' && typeof args.condition !== 'string' )
						|| typeof args.cb !== 'function' ) {
					console.error( 'Invalid arguments to waitFor' );
					phantom.fail( 'Invalid arguments to waitFor' );
					return false;
				}

				if ( typeof args.condition === 'string' && typeof jQuery !== 'function' ) {
					console.error( 'Cannot use string condition to waitFor without jQuery' );
					phantom.fail( 'Cannot use string condition to waitFor without jQuery' );
					return false;
				}

				args.conditionArgs = args.conditionArgs || [ ];
				args.cbArgs = args.cbArgs || [ ];
				args.interval = args.interval || 500;
				args.failurecb = args.failurecb || null;
				args.failurecbArgs = args.failurecbArgs || [ ];
				args.end_time = args.end_time || ( args.timeout ? ( new Date( ) ).getTime( ) + args.timeout : Infinity );

				var getCondition = function ( condition, conditionArgs )
				{
					var result;
					if ( typeof condition === 'function' ) {
						result = condition.apply( condition, conditionArgs );
					} else {
						result = ( function elementExists( condition ) {
							return jQuery( condition ).length > 0;
						})( condition );
					}
					return result;
				};

				if ( getCondition( args.condition, args.conditionArgs ) ) {
					setTimeout( function ( ) {
						args.cb.apply( args.cb, args.cbArgs );
					}, 100 );
				} else {
					if ( ( new Date( ) ).getTime( ) > args.end_time ) {
						if ( typeof args.failurecb === 'function' ) {
							args.failurecb.apply( args.failurecb, args.failurecbArgs );
						} else {
							console.error( 'Timed out while waiting for event' );
							phantom.fail( 'Timed out while waiting for event', phantom.TIMEOUT_STATUS_CODE );
						}
					} else {
						setTimeout( phantom.waitFor, args.interval, args );
					}
				}
			},
			waitForjQuery: function ( cb, interval )
			{
				this.waitFor({
					condition: function ( ) {
						return typeof jQuery !== 'undefined';
					},
					cb: cb,
					interval: interval
				});
			}
		};
	});

	var end_time = ( new Date( ).getTime( ) ) + params.timeout;

	var executeRequest = function( )
	{
		if ( params.noConflict ) {
			console.log( 'Modifying request script to accomodate noConflict...' );
			params.js = params.js
				.replace( /\$\(/g, '$jq(' )
				.replace( /\$\./g, '$jq.' );
		}
		page.evaluate( function ( ) {
			window.onbeforeunload = function ( ) {
				phantom.fail( 'ERROR: ATTEMPTED NAVIGATION' );
				console.error( 'LIVESCRAPE ERROR: Page navigation attempted' );
				return 'test';
			};
		});
		if ( params.args ) {
			page.evaluate( params.js, params.args );
		} else {
			page.evaluate( params.js );
		}
		checkOutput( page, end_time );
	}



	if ( params.inject ) {
		var body_timeout = ( new Date( ).getTime( ) ) + 3000;
		var checkForBody = function ( )
		{
			var body = page.evaluate( function( ) { return !!document.body; } );
			if ( body ) {
				console.log( 'Injecting jQuery' );
				page.includeJs( 'https://ajax.googleapis.com/ajax/libs/jquery/2.2.0/jquery.min.js', function( ) {
					executeRequest( );
				});
			} else if ( new Date( ).valueOf( ) > body_timeout ) {
				console.error( 'Unable to inject jQuery: <body> not loaded' );
				console.sendResult( { error: 'Unable to inject jQuery: <body> not loaded' } );
			} else {
				setTimeout( checkForBody, 500 );
			}
		}
		checkForBody( );
	} else {
		executeRequest( );
	}
}



console.log( 'Initialized' );

var input = '';
var line;
while ( line = system.standardin.read( ) ) {
	input += line;
}
var job = JSON.parse( input );

console.log( 'Got job:', job );

job.timeout = job.timeout || DEFAULTS.TIMEOUT;
job.loadtime = job.loadtime || DEFAULTS.LOADTIME;
if ( job.url && job.js ) {
	job.inject = job.inject || false;
	var swapped = false;
	( function buildPage ( ) {
		phantom.clearCookies( );
		var page = pages.create();
		page.pageUrl = job.url;
		page.request_organization = job.organization;
		page.request_user = job.username;
		page.request_id = job.req;
		page.request_query_id = job.query;
		page.request_napp = job.napp;
		console.log( 'Initiating request for', job.url );
		//Phantom default: Mozilla/5.0 (Unknown; Linux x86_64) AppleWebKit/538.1 (KHTML, like Gecko) PhantomJS/2.1.1 Safari/538.1
		page.settings.userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/48.0.2564.109 Safari/537.36';
		page.onError = function ( msg, trace )
		{
			// console.log( 'page error' );
			console.error( getStackTrace( msg, trace ) );
		};
		page.onConsoleMessage = console.log.bind( console );

		page.onResourceError = function ( resourceError ) {
			// console.log( 'page resource error' );
			console.error( resourceError.url + ':',  resourceError.errorString );
		};
		page._self_timeout = setTimeout( function ( ) {
			console.error( 'Execution timed out before getting output' );
			console.sendResult( { timeout: true } );
		}, job.timeout );
		// page.viewportSize = { width: 1920, height: 1080 };

		// this allows us to avoid cross origin issues when accessing the contents of iframes
		page.settings.webSecurityEnabled = false;
	
		page.open( job.url, function( status ) {
			// page.navigationLocked = true;
			if ( status === 'success' ) {
				setTimeout( function ( ) {
					processPage( page, job );
				}, job.loadtime );
			} else if ( !swapped && /^http:\/\//.test( job.url ) || !( /:\/\//.test( job.url ) ) ) {
				job.url = job.url.replace( /^(?:http:\/\/)?/, 'https://' );
				swapped = true;
				clearTimeout( page._self_timeout );
				page.close( );
			
				setTimeout( buildPage, 2000 );
			} else if ( !swapped && /^https:\/\//.test( job.url ) ) {
				job.url = job.url.replace( /^https:\/\//, 'http://' );
				swapped = true;
				clearTimeout( page._self_timeout );
				page.close( );
			
				setTimeout( buildPage, 2000 );
			} else {
				console.error( 'Error opening page:', job.url );
				console.sendResult( { error: 'Error opening page' } );
			}
		});
	})( );
} else {
	console.error( 'Invalid request parameters' );
	console.sendResult( { error: 'Invalid request parameters' } );
}
