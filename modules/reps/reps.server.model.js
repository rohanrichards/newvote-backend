'use strict';

/**
 * Module dependencies.
 */
let mongoose = require('mongoose'),
    Schema = mongoose.Schema;


/**
 * Article Schema
 */
let RepSchema = new Schema({
    created: {
        type: Date,
        default: Date.now
    },
    displayName: {
        type: String
    },
    position: {
        type: String
    },
    description: {
        type: String,
        default: '',
        trim: true
    }, 
    organizations: {
        type: Schema.ObjectId,
        ref: 'Organization'
    },
    issues: [{
        type: Schema.ObjectId,
        ref: 'Issue',
        required: true
    }],
    solutions: [{
        type: Schema.ObjectId,
        ref: 'Solution',
        required: true
    }],
    proposals: [{
        type: Schema.ObjectId,
        ref: 'Proposal'
    }],
    owner: {
        type: Schema.ObjectId,
        ref: 'User'
    },
    imageUrl: {
        type: String,
        default: 'assets/logo-no-text.png'
    }
});


mongoose.model('Rep', RepSchema);
