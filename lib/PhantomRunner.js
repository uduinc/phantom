const MongoClient = require( 'mongodb' ).MongoClient;
const _ = require( 'lodash' );
const request = require( 'request' );

const Job = require( './Job' );
const Logger = require( './Logger' );

const DEFAULTS = require( './defaults.json' );

const hostname = require( 'os' ).hostname( );

const SCRAPER_TIMEOUT = 'Scraper failed to respond, killing';

exports = module.exports = class PhantomRunner {
	constructor ( opts ) {
		this.logger = opts.logger || new Logger( );
		this.maxJobs = opts.maxJobs || 5;
		if ( opts.metrics ) {
			this.metrics = opts.metrics;
		}
		MongoClient.connect( opts.mongoUrl ).then( db => {
			this.db = db;
			this.resetJobsBy( { owner: hostname } ).then( () => this.init( ) );
		}).catch( err => {
			this._killing = true;
			this.logger.error( 'Error connecting to mongo:', err );
			setTimeout( process.exit, 3000 );
		});
	}

	set jobsOpen ( val ) {
		this._jobsOpen = val;
		if ( this.metrics ) {
			this.metrics.setValue( 'pages', val );
		}
	}

	get jobsOpen ( ) {
		return this._jobsOpen;
	}

	init ( ) {
		this.jobsOpen = 0;
		this.mainLoop = this.main( );
		this.mainLoop.next( );
		this.jobComplete = () => {};

		setInterval( () => this.cleanupJobs( ), DEFAULTS.CLEANUP_INTERVAL );

		this.updateLoggingIgnore( );
		setInterval( () => this.updateLoggingIgnore( ), DEFAULTS.LOGGING_IGNORE_INTERVAL );

		setInterval( () => this.ensureConnected( ), DEFAULTS.DB_CONNECTION_CHECK_INTERVAL );
	}

	ensureConnected ( ) {
		if ( this._killing ) {
			return;
		}
		this.connectionFailures = this.connectionFailures || 0;
		if ( this.db.serverConfig.isConnected( ) ) {
			this.connectionFailures = 0;
		} else {
			if ( ++this.connectionFailures > DEFAULTS.DB_CONNECTION_CHECK_MAX_FAILURES ) {
				this.logger.error( `Mongo connection dead and not revived for ${DEFAULTS.DB_CONNECTION_CHECK_MAX_FAILURES}`
					+ ` checks at ${DEFAULTS.DB_CONNECTION_CHECK_INTERVAL}ms intervals. Killing process` );
				this._killing = true;
				setTimeout( process.exit, 3000 );
			}
		}
	}

	updateLoggingIgnore ( ) {
		if ( this._updatingLoggingIgnore ) return;
		this.updatingLoggingIgnore = true;
		this.db.collection( 'meta' ).findOne( { key: 'logging_ignore' }, ( err, data ) => {
			if ( err ) {
				this.logger.error( 'Error getting logging ignore list:', err );
				this._updatingLoggingIgnore = false;
				return;
			}

			if ( !data ) {
				this._updatingLoggingIgnore = false;
				return;
			}

			try {
				var ignores = JSON.parse( data.value );
				this.logger.ignore = ignores;
			} catch ( err ) {
				this.logger.error( 'Error parsing logging ignore list:', err );
			} finally {
				this._updatingLoggingIgnore = false;
			}
		});
	}

	* main ( ) {
		while ( true ) {
			let job = yield this.getJob( );
			this.jobsOpen++;
			// this.logger.log( 'Starting new job:', job.params );
			let timeout = new Promise( ( resolve, reject ) => {
				setTimeout( () => {
					reject( SCRAPER_TIMEOUT );
				}, ( job.params.timeout || DEFAULTS.TIMEOUT ) + ( job.params.loadtime || DEFAULTS.LOADTIME ) + DEFAULTS.TIMEOUT_OVERHEAD );
			});
			Promise.race( [ timeout, job.run( ) ] ).then( result => this.save( job, result ) ).catch( err => this.save( job, err, true ) );
		}
	}

	save ( job, result, wasErr ) {
		if ( result === SCRAPER_TIMEOUT ) {
			this.logger.error(job.params.meta.request_id + ": " + SCRAPER_TIMEOUT );
			job.kill( );
		}
		this.jobsOpen--;
		this.jobComplete( );
		this.db.collection( 'phantomjs-results' ).insert({
			id: job.id,
			source: job.source,
			error: !!wasErr,
			result: result
		});
		this.db.collection( 'phantomjs-jobs' ).deleteOne( { id: job.id } );
	}

	waitForJobOpen ( ) {
		if ( this.jobsOpen < this.maxJobs ) {
			return Promise.resolve( );
		} else {
			return new Promise( resolve => {
				this.jobComplete = resolve;
			});
		}
	}

	getJob ( ) {
		this.waitForJobOpen( ).then( () => {
			this.db.collection( 'phantomjs-jobs' ).findOneAndUpdate( { owner: { $exists: false } }, {
				$set: {
					owner: hostname,
					time: Date.now( ),
					expiration: Date.now( ) + DEFAULTS.INITIAL_EXPIRATION_OVERHEAD
				}
			}, { returnOriginal: false } ).then( data => {
				if ( data.value ) {
					this.db.collection( 'phantomjs-jobs' ).updateOne( { id: data.value.id }, {
						$set: {
							expiration: data.value.time
								+ ( data.value.timeout || DEFAULTS.TIMEOUT )
								+ ( data.value.loadtime || DEFAULTS.LOADTIME )
								+ DEFAULTS.TIMEOUT_OVERHEAD
						}
					}).then( () => {
						if ( !data.value.meta ) {
							data.value.meta = {
								organization: data.value.organization,
								user_organization: data.value.user_organization,
								'n-app': data.value.napp,
								request_id: data.value.req,
								request_query_id: data.value.query
							};
						}
						this.mainLoop.next( new Job( data.value, this.logger ) );
					}).catch( err => {
						this.logger.error( 'Error adding timeout to job:', err );
						this.resetJob( data.value, () => setTimeout( getJob, DEFAULTS.JOB_CHECK_INTERVAL, db ) );
					});
				} else {
					setTimeout( () => this.getJob( ), DEFAULTS.JOB_CHECK_INTERVAL );
				}
			}).catch( err => {
				this.logger.error( 'Error checking job queue:', err );
				setTimeout( () => this.getJob( ), DEFAULTS.JOB_CHECK_INTERVAL );
			});
		});
	}

	resetJob ( job, cb ) {
		return this.resetJobsBy( { id: job.id } );
	}

	resetJobsBy ( filter ) {
		// this.logger.log( 'Resetting jobs by:', filter );
		return new Promise( ( resolve, reject ) => {
			this.db.collection( 'phantomjs-jobs' ).updateMany( filter, {
				$unset: {
					owner: true,
					time: true,
					expiration: true
				}
			}).then( resolve ).catch( err => {
				this.logger.error( '!!! Error resetting jobs:', err );
				reject( err );
			});
		});
	}

	cleanupJobs ( ) {
		if ( this.runningCleanup ) return;
		this.runningCleanup = true;
		const doneFunc = () => { this.runningCleanup = false };
		const errFunc = ( err ) => {
			this.logger.error( 'Error cleaning up jobs:', err );
			doneFunc( );
		};
		this.db.collection( 'phantomjs-jobs' ).distinct( 'owner', { expiration: { $lt: Date.now( ) } } ).then( hosts => {
			let promises = [];
			_.each( hosts, host => {
				promises.push( new Promise( ( resolve, reject ) => {
					request( 'http://'+host+':8082', ( err, res, response ) => {
						if ( err || res.statusCode !== 200 ) {
							this.resetJobsBy({
								owner: host,
								expiration: { $lt: Date.now( ) }
							}).then( resolve, reject );
						} else {
							resolve( );
						}
					});
				}));
			});
			Promise.all( promises ).then( doneFunc ).catch( errFunc );
		}).catch( errFunc );
	}
}