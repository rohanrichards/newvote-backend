'use strict';

/**
 * Module dependencies.
 */
let path = require('path'),
    config = require(path.resolve('./config/config')),
    passport = require('passport'),
    passportJWT = require('passport-jwt'),
    JWTStrategy = passportJWT.Strategy,
    ExtractJWT = passportJWT.ExtractJwt,
    User = require('mongoose')
        .model('User'),
    users = require('../users.server.controller');

module.exports = function () {
    let options = {
        jwtFromRequest: ExtractJWT.fromBodyField('assertion'),
        secretOrKey: config.jwtSecret,
        issuer: config.jwtIssuer,
        audience: config.jwtAudience,
        passReqToCallback: true
    }
    console.debug('JWT options: ', options);
    passport.use(new JWTStrategy(options,
        function (req, jwtPayload, done) {
            let profile = jwtPayload['https://aaf.edu.au/attributes']
            profile.jwt = req.body.assertion
            profile.jti = jwtPayload.jti

            users.saveRapidProfile(req, profile, done);
        }
    ));
};
