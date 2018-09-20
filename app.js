#!/usr/bin/env node
const request = require( 'request' );

let appArgs = [].concat( process.argv );
if ( appArgs[0].indexOf( 'app.js' ) === -1 ) {
	appArgs.splice( 0, 1 );
}
logFile = appArgs.length > 1 ? appArgs[ 1 ] : null;

const hostname = require( 'os' ).hostname( );

const config = require( './config' );
const Metrics = require( './lib/Metrics' );
const PhantomRunner = require( './lib/PhantomRunner' );
const Logger = require( './lib/Logger' );


const logger = new Logger( logFile, config.logseneToken, { source: 'phantom', hostname } );
logger.log( '********** SERVER RESTART **********' );

const metrics = new Metrics( config.metricsServerUrl, config.metricsKey, Object.assign( { instance: hostname }, config.metricsMeta || {} ), { logger } );

if ( config.stackdriverProject ) {
	let zone = null;
	let instance_id = null;

	const done = ( ) => {
		metrics.addStackdriver( config.stackdriverProject, {
			resource: { type: 'gce_instance', labels: { zone, instance_id } },
			labels: { environment: config.cluster, hostname, zone, instance_id }
		});
	};
	( function getMetadata( ) {
		let hadErr = true;
		let otherDone = false;
		if ( !zone ) {
			request({
				url: 'http://metadata.google.internal/computeMetadata/v1/instance/zone',
				headers: { 'Metadata-Flavor': 'Google' }
			}, ( err, res, response ) => {
				if ( err || res.statusCode !== 200 ) {
					hadErr = true;
				} else {
					let zoneSplit = response.split( '/' );
					zone = zoneSplit[ zoneSplit.length - 1 ];
				}
				if ( otherDone ) {
					if ( !zone || !instance_id ) {
						setTimeout( getMetadata, 1000 );
					} else {
						done( );
					}
				}
				otherDone = true;
			});
		}

		if ( !instance_id ) {
			request({
				url: 'http://metadata.google.internal/computeMetadata/v1/instance/id',
				headers: { 'Metadata-Flavor': 'Google' }
			}, ( err, res, response ) => {
				if ( err || res.statusCode !== 200 ) {
					hadErr = true;
				} else {
					instance_id = response;
				}
				if ( otherDone ) {
					if ( !zone || !instance_id ) {
						setTimeout( getMetadata, 1000 );
					} else {
						done( );
					}
				}
				otherDone = true;
			});
		}
	})( );
}

const phantom = new PhantomRunner( { mongoUrl: config.mongoUrl, logger, metrics, maxJobs: config.maxJobs } );


const http = require( 'http' );
const server = http.createServer( ( req, res ) => {
	res.end( ''+phantom.jobsOpen );
});

server.listen( 8082 );