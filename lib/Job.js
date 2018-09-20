const ChildProcess = require( 'child_process' );

const _ = require( 'lodash' );

const Logger = require( './Logger' );

const phantomPath = require( 'phantomjs-prebuilt' ).path;
const phantomArgs = [ require( 'path' ).join( __dirname, 'phantom.js' ) ];

const PHANTOMJS_MESSAGE_STARTER = '*!*!*!*!STARTING PHANTOMJS MESSAGE!*!*!*!*';
const PHANTOMJS_MESSAGE_ENDER = '*!*!*!*!ENDING PHANTOMJS MESSAGE!*!*!*!*';

exports = module.exports = class Job {
	constructor ( params, logger ) {
		this.id = params.id;
		this.source = params.source;
		this.logMeta = _.merge( { pageUrl: params.url }, params.meta );
		this.params = params;
		this.logger = logger || new Logger( );
	}

	handlePhantomMessage ( str, resolve ) {
		let obj = null;
		try {
			obj = JSON.parse( str );
		} catch ( err ) {
			this.logger.error( 'Failed to parse phantom message:', str );
			return;
		}

		if ( obj.result ) {
			this._resolve( obj.result );
		} else if ( obj.log ) {
			this.logger.logWithMeta( this.logMeta, obj.log );
		} else if ( obj.error ) {
			this.logger.errorWithMeta( this.logMeta, obj.error );
		} else {
			this.logger.error( 'Unknown phantom message type:', obj );
		}
	}

	run ( ) {
		if ( this.promise ) return this.promise;
		return this.promise = new Promise( ( resolve, reject ) => {
			let origResolve = resolve;
			let origReject = reject;
			let fulfilled = false;
			resolve = ( ...args ) => {
				fulfilled = true;
				origResolve( ...args );
			};
			reject = ( ...args ) => {
				fulfilled = true;
				origReject( ...args );
			};
			this._resolve = resolve;
			this._reject = reject;
			this.phantom = ChildProcess.spawn( phantomPath, phantomArgs );

			this.phantom.stdout.on( 'data', msg => {
				msg = msg.toString( );
				if ( msg[ msg.length -1 ] === '\n' ) {
					msg = msg.slice( 0, -1 );
				}

				while ( msg.trim( ).length ) {
					if ( typeof this.readingPhantomMessage === 'string' ) {
						let end = msg.indexOf( PHANTOMJS_MESSAGE_ENDER );
						if ( end > -1 ) {
							this.readingPhantomMessage += msg.slice( 0, end );
							msg = msg.slice( end + PHANTOMJS_MESSAGE_ENDER.length );
							this.handlePhantomMessage( this.readingPhantomMessage );
							this.readingPhantomMessage = false;
						} else {
							this.readingPhantomMessage += msg;
							msg = '';
						}
					} else {
						let end = msg.indexOf( PHANTOMJS_MESSAGE_STARTER );
						if ( end > -1 ) {
							if ( end ) {
								let logMsg = msg.slice( 0, end );
								if ( logMsg.trim( ).length ) this.logger.log( logMsg );
							}
							msg = msg.slice( end + PHANTOMJS_MESSAGE_STARTER.length );
							this.readingPhantomMessage = '';
						} else {
							this.logger.log( msg );
							msg = '';
						}
					}
				}
			});
			this.phantom.stderr.on( 'data', d => this.logger.error( d.toString( ) ) );

			this.phantom.on( 'message', msg => {
				if ( msg.result ) {
					resolve( msg.result );
				} else if ( msg.log ) {
					this.logger.logWithMeta( this.logMeta, msg.log );
				} else if ( msg.errlog ) {
					this.logger.errorWithMeta( this.logMeta, msg.errlog );
				}
			});

			this.phantom.on( 'error', err => {
				this.logger.error( '!!! ERROR handling phantom process: got err ' + util.inspect( err, { colors: true, depth: 4 } ) );
				reject( 'Error spawning scraper' );
				this.kill( );
			});

			this.phantom.on( 'close', ( code, signal ) => {
				if ( fulfilled ) return;
				this.logger.error( `!!! ERROR: Phantomjs process exited without returning result: code ${code} | signal ${signal}` );
				reject( 'Scraper crashed or exited without returning results' );
			});

			this.phantom.stdin.write( JSON.stringify( this.params ) );
			this.phantom.stdin.end( );
		});
	}

	kill ( ) {
		if ( !this.phantom ) throw new Error( 'kill( ) called on job that has not yet run' );

		this.phantom.kill( 'SIGKILL' );
		this._reject( 'Phantom process killed by application' );
	}
}