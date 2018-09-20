const util = require( 'util' );

const _ = require( 'lodash' );
const logsene = require( 'winston-logsene' );
const winston = require( 'winston' );

exports = module.exports = class Logger {
	constructor ( logfile, logseneToken, defaultMeta ) {
		let transports = [
			new winston.transports.Console({
				exitOnError: !( logfile || logseneToken ),
				formatter: options => `${ new Date( ).toISOString( ) } | [${ options.level.toUpperCase( ) }] ${ options.message || '' }`
			})
		];

		if ( logfile ) {
			transports.push( new winston.transports.File({
				exitOnError: !logseneToken,
				handleExceptions: true,
				humanReadableUnhandledException: true,
				filename: logfile,
				formatter: options => `${ new Date( ).toISOString( ) } | [${ options.level.toUpperCase( ) }] ${ options.message || '' }`,
				json: false
			}));
		}

		this.logger = new winston.Logger({
			level: 'debug',
			transports: transports
		});

		if ( logseneToken ) {
			this.logger.add( logsene, {
				token: logseneToken,
				exitOnError: true,
				handleExceptions: true,
				humanReadableUnhandledException: true
			});
		}

		this.counter = 0;
		this.meta = defaultMeta;
		this.ignore = [];
	}

	_log ( type, meta, ...args ) {
		meta = _.merge( {}, this.meta, { counter: this.counter++ }, meta );
		for ( var i=0, len=this.ignore.length; i<len; i++ ) {
			if ( _.isMatch( _.merge( { severity: type }, meta ), this.ignore[ i ] ) ) {
				return;
			}
		}
		this.logger.log( type, args.map( o => {
			if ( typeof o === 'object' ) {
				return util.inspect( o, { depth: 4 } );
			} else {
				return o;
			}
		}).join( ' ' ), meta );
	}

	logWithMeta ( meta, ...args ) {
		this._log( 'debug', meta, ...args );
	}

	errorWithMeta ( meta, ...args ) {
		this._log( 'error', meta, ...args );
	}

	log ( ...args ) {
		this.logWithMeta( {}, ...args );
	}

	error( ...args ) {
		this.errorWithMeta( {}, ...args );
	}
}