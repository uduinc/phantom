const _ = require( 'lodash' );
const gcloudmon = require( 'gcloudmon' );
const request = require( 'request' );
const CryptoJS = require( 'crypto-js' );


// worst-case direction for metrics: true = higher is worse
// note: any metrics not defined here default to false
const WORST_CASE_HIGHER = {
	pages: true
};

exports = module.exports = class Metrics {
	constructor ( endpoint, key, labels, opts ) {
		opts = opts || {};
		this.metricsEndpoint = endpoint;
		this.metricsKey = key;
		this.labels = labels;
		this.metrics = {};
		this.summaryMetrics = {}; // worst-case metrics, as collected between each send( )
		this.logger = opts.logger || console;
		if ( opts.stackdriver ) {
			this.addStackdriver( opts.stackdriver.project, opts.stackdriver.meta );
		}
		setInterval( () => this.send( ), 10000 );
	}

	addStackdriver ( project, meta ) {
		this.stackdriverMeta = meta;
		this.stackdriver = new gcloudmon( { project, authType: 'getApplicationDefault' } );
		this.stackdriver.on( 'error', err => this.logger.error( 'Something bad happened:', err.message ) );
	}

	setValue ( k, v ) {
		this.metrics[ k ] = v;
		if ( this.summaryMetrics.hasOwnProperty( k ) ) {
			if ( WORST_CASE_HIGHER[ k ] ) {
				this.summaryMetrics[ k ] = Math.max( this.summaryMetrics[ k ], v );
			} else {
				this.summaryMetrics[ k ] = Math.min( this.summaryMetrics[ k ], v );
			}
		} else {
			this.summaryMetrics[ k ] = v;
		}
	}

	send ( ) {
		if ( !_.size( this.summaryMetrics ) ) return;
		const metricsArray = _.map( this.summaryMetrics, ( v, k ) => ( { metricType: 'phantom/'+k, metricValue: v } ) );
		this.summaryMetrics = _.clone( this.metrics );

		if ( this.metricsEndpoint && this.metricsKey ) {
			request({
				url: this.metricsEndpoint,
				method: 'POST',
				json: {
					metrics: metricsArray,
					labels: this.labels,
					source: 'phantom',
					hash: CryptoJS.MD5( JSON.stringify( metricsArray ) + this.metricsKey ).toString( )
				}
			}, ( err, res, response ) => {
				if ( ( err || res.statusCode > 204 ) && ( this.labels.cluster !== 'localhost' || !err || err.code !== 'HPE_INVALID_CONSTANT' ) ) {
					this.logger.error( 'Error sending metrics:', err || response );
				}
			});
		}

		if ( this.stackdriver ) {
			this.stackdriver.setValues( _.map( metricsArray, v => _.merge( {}, this.stackdriverMeta, v ) ), ( err, data ) => {
				if ( err ) {
					this.logger.error( 'Error sending metrics to stackdriver:', err );
				}
			});
		}
	}
}