'use strict';

/**
 * Module dependencies.
 */
const path = require('path'),
    config = require(path.resolve('./config/config')),
    errorHandler = require(path.resolve(
        './modules/core/errors.server.controller'
    )),
    _ = require('lodash'),
    mongoose = require('mongoose'),
    jwt = require('jsonwebtoken'),
    passport = require('passport'),
    User = mongoose.model('User'),
    Vote = mongoose.model('Vote'),
    Organization = mongoose.model('Organization'),
    FutureLeader = mongoose.model('FutureLeader'),
    nodemailer = require('nodemailer'),
    transporter = nodemailer.createTransport(config.mailer.options),
    Mailchimp = require('mailchimp-api-v3'),
    Recaptcha = require('recaptcha-verify'),
    async = require('async');

// URLs for which user can't be redirected on signin
const noReturnUrls = ['/authentication/signin', '/authentication/signup'];

const recaptcha = new Recaptcha({
    secret: config.reCaptcha.secret,
    verbose: true
});

const addToMailingList = function (user) {
    const mailchimp = new Mailchimp(config.mailchimp.api);
    const MAILCHIMP_LIST_ID = config.mailchimp.list;

    return mailchimp.post(`/lists/${MAILCHIMP_LIST_ID}/members`, {
        email_address: user.email,
        status: 'subscribed'
    });
};

exports.checkAuthStatus = function (req, res, next) {
    passport.authenticate('check-status', {
        session: false
    }, function (
        err,
        user,
        info
    ) {
        if (err || !user) {
            return res.status(400).send(info);
        }

        // Remove sensitive data before login
        user.password = undefined;
        user.salt = undefined;
        user.verificationCode = undefined;

        req.login(user, function (err) {
            if (err) {
                res.status(400).send(err);
            } else {
                const payload = {
                    _id: user._id,
                    roles: user.roles,
                    verified: user.verified
                };
                const token = jwt.sign(payload, config.jwtSecret, {
                    expiresIn: config.jwtExpiry
                });
                const creds = {
                    user,
                    token
                };
                const opts = {
                    domain: 'newvote.org',
                    httpOnly: false,
                    secure: false
                };

                res.cookie('credentials', JSON.stringify(creds), opts);
                res.json(creds);
            }
        });
    })(req, res, next);
};

/**
 * Signup
 */
exports.signup = function (req, res) {
    // Init Variables
    const user = new User(req.body);
    const {
        recaptchaResponse,
        email,
        password
    } = req.body;
    const verificationCode = req.params.verificationCode;

    if (!email || !password) {
        return res.status(400).send({
            message: 'Email / Password Missing'
        });
    }

    // For security measurement we remove the spice rackroles from the req.body object
    delete req.body.roles;

    //ensure captcha code is valid or return with an error
    recaptcha.checkResponse(recaptchaResponse, function (err, response) {
        if (err || !response.success) {
            return res.status(400).send({
                message: 'Recaptcha verification failed.'
            });
        } else {
            //user is not a robot, captcha success, continue with sign up
            // Add missing user fields
            user.provider = 'local';
            //set the username to e-mail to satisfy unique indexes
            //we cant just remove username as its the index for the table
            //we'd have to drop the entire table to change the index field
            user.username = user.email;

            // If a user has been added as a future leader handle here
            if (verificationCode) {
                return handleLeaderVerification(user, verificationCode)
                    .then(savedUser => {
                        try {
                            addToMailingList(savedUser)
                                .then(results => {
                                    // console.log('Added user to mailchimp');
                                })
                                .catch(err => {
                                    console.log(
                                        'Error saving to mailchimp: ',
                                        err
                                    );
                                });
                        } catch (err) {
                            console.log('Issue with mailchimp: ', err);
                        }
                        return loginUser(req, res, savedUser);
                    })
                    .catch(err => {
                        return res.status(400).send({
                            message: errorHandler.getErrorMessage(err)
                        });
                    });
            }

            return user
                .save()
                .then(doc => {
                    try {
                        addToMailingList(doc)
                            .then(results => {
                                // console.log('Added user to mailchimp');
                            })
                            .catch(err => {
                                console.log('Error saving to mailchimp: ', err);
                            });
                    } catch (err) {
                        console.log('Issue with mailchimp: ', err);
                    }

                    return loginUser(req, res, doc);
                })
                .catch(err => {
                    console.log(err, 'this is err');
                    return res.status(400).send({
                        message: errorHandler.getErrorMessage(err)
                    });
                });
        }
    });
};

const buildMessage = function (user, code, req) {
    let messageString = '';
    const url = req.protocol + '://' + req.get('host') + '/verify/' + code;

    messageString += `<h3> Welcome ${user.firstName} </h3>`;
    messageString += `<p>Thank you for joining the NewVote platform, you are almost ready to start having your say!
	To complete your account setup, just click the URL below or copy and paste it into your browser's address bar</p>`;
    messageString += `<p><a href='${url}'>${url}</a></p>`;

    return messageString;
};

const sendEmail = function (user, pass, req) {
    return transporter.sendMail({
        from: process.env.MAILER_FROM,
        to: user.email,
        subject: 'NewVote UQU Verification',
        html: buildMessage(user, pass, req)
    });
};

/**
 * Signin after passport authentication
 */
exports.signin = function (req, res, next) {
    passport.authenticate('local', {
        session: false
    }, function (
        err,
        user,
        info
    ) {
        if (err || !user) {
            res.status(400).send(info);
        } else {
            // need to update user orgs in case they've voted on a new org
            // exports.updateOrgs(user);

            // User is already signed to another organization and is verifying with current org
            if (req.cookies.credentials) {
                let {
                    credentials
                } = req.cookies;
                credentials = JSON.parse(credentials);

                return jwt.verify(credentials.token, config.jwtSecret, function (
                    err,
                    verifiedUser
                ) {
                    if (err) {
                        res.clearCookie('credentials', {
                            path: '/',
                            domain: 'newvote.org'
                        });
                        throw 'Invalid token';
                    }

                    const organizationPromise = Organization.findOne({
                        _id: req.organization._id
                    });
                    const userPromise = User.findOne({
                        _id: verifiedUser._id
                    });

                    return Promise.all([organizationPromise, userPromise])
                        .then(promises => {
                            const [organization, user] = promises;
                            user.organizations.push(organization._id);
                            return user.save();
                        })
                        .then(savedUser => {
                            savedUser.password = undefined;
                            savedUser.salt = undefined;
                            savedUser.verificationCode = undefined;

                            // updated user so create new token
                            const payload = {
                                _id: savedUser._id,
                                roles: savedUser.roles,
                                verified: savedUser.verified
                            };
                            const token = jwt.sign(payload, config.jwtSecret, {
                                expiresIn: config.jwtExpiry
                            });
                            const creds = { user, token };

                            const opts = {
                                domain: 'newvote.org',
                                secure: false,
                                overwrite: true
                            }

                            res.cookie(
                                'credentials',
                                JSON.stringify(creds),
                                opts
                            );
                            res.json(creds);
                        });
                });
            }

            User.populate(user, {
                path: 'country'
            }).then(function (user) {
                // Remove sensitive data before login
                user.password = undefined;
                user.salt = undefined;
                user.verificationCode = undefined;

                req.login(user, function (err) {
                    if (err) {
                        res.status(400).send(err);
                    } else {
                        const payload = {
                            _id: user._id,
                            roles: user.roles,
                            verified: user.verified
                        };
                        const token = jwt.sign(payload, config.jwtSecret, {
                            expiresIn: config.jwtExpiry
                        });
                        const creds = {
                            user,
                            token
                        };
                        const opts = {
                            domain: 'newvote.org',
                            httpOnly: false,
                            secure: false
                        };

                        res.cookie('credentials', JSON.stringify(creds), opts);
                        res.json(creds);
                    }
                });
            });
        }
    })(req, res, next);
};

/**
 * Signout
 */
exports.signout = function (req, res) {
    req.logout();
    res.redirect('/');
};

/**
 * OAuth provider call
 */
exports.oauthCall = function (strategy, scope) {
    return function (req, res, next) {
        // Set redirection path on session.
        // Do not redirect to a signin or signup page
        if (noReturnUrls.indexOf(req.query.redirect_to) === -1) {
            req.session.redirect_to = req.query.redirect_to;
        }
        // Authenticate
        passport.authenticate(strategy, scope)(req, res, next);
    };
};

/**
 * OAuth callback
 */
exports.oauthCallback = function (strategy) {
    return function (req, res, next) {
        // ;
        try {
            var sessionRedirectURL = req.session.redirect_to;
            delete req.session.redirect_to;
        } catch (e) {
            // quietly now
        }

        passport.authenticate(strategy, function (err, user, redirectURL) {
            //   https://rapid.test.aaf.edu.au/jwt/authnrequest/research/4txVkEDrvjAH6PxxlCKZGg
            // need to generate url from org in request cookie here
            let orgObject = req.organization;
            let org = orgObject ? orgObject.url : 'home';
            let host = '';
            if (config.node_env === 'development') {
                host = `http://${org}.localhost.newvote.org:4200`;
            } else {
                host = `https://${org}.newvote.org`;
            }

            if (err) {
                return res.redirect(
                    host +
                    '/auth/login?err=' +
                    encodeURIComponent(errorHandler.getErrorMessage(err))
                );
            }
            if (!user) {
                return res.redirect(host + '/auth/login?err="400_JWT_SIGNATURE"');
            }
            req.login(user, function (err) {
                if (err) {
                    return res.redirect(host + '/auth/login');
                }
                const payload = {
                    _id: user._id,
                    roles: user.roles,
                    verified: user.verified
                };
                const token = jwt.sign(payload, config.jwtSecret, {
                    expiresIn: config.jwtExpiry
                });
                const creds = {
                    user,
                    token
                };
                const opts = {
                    domain: 'newvote.org',
                    httpOnly: false,
                    secure: false
                };
                res.cookie('credentials', JSON.stringify(creds), opts);
                const redirect = sessionRedirectURL ?
                    host + sessionRedirectURL :
                    host + '/';
                return res.redirect(302, redirect);
            });
        })(req, res, next);
    };
};

/**
 * Helper function to create or update a user after AAF Rapid SSO auth
 */
exports.saveRapidProfile = function (req, profile, done) {
    const organizationPromise = Organization.findOne({
        _id: req.organization._id
    });
    const userPromise = User.findOne({
        email: profile.mail
    },
    '-salt -password -verificationCode'
    );

    Promise.all([organizationPromise, userPromise])
        .then(promises => {
            let [organization, user] = promises;

            const {
                edupersoncid,
                edupersontargetedid,
                edupersonscopedaffiliation
            } = profile;

            const aafAttributes = {
                edupersoncid,
                edupersontargetedid,
                edupersonscopedaffiliation,
                edupersonprincipalname: profile.edupersonprincipalname ? profile.edupersonprincipalname : ''
            }

            // extract aaf attributes from profile
            // add organization url to match against current organization for votes
            const providerData = {
                [organization.url]: aafAttributes
            }

            if (!user) {
                console.log('no user, creating new account');
                const possibleUsername =
                    profile.cn ||
                    profile.displayname ||
                    profile.givenname + profile.surname ||
                    (profile.mail ? profile.mail.split('@')[0] : '');

                User.findUniqueUsername(possibleUsername, null, function (
                    availableUsername
                ) {
                    console.log('generated username: ', availableUsername);
                    user = new User({
                        firstName: profile.givenname,
                        lastName: profile.surname,
                        username: profile.mail,
                        displayName: profile.displayname,
                        email: profile.mail,
                        provider: 'aaf',
                        providerData: providerData,
                        ita: profile.ita,
                        roles: ['user'],
                        verified: true,
                        organizations: [organization._id]
                    });
                    // And save the user
                    return user.save();
                });
            } else {

                if (!user.providerData) user.providerData = {}
                const userProviders = user.providerData;
                const providerExists = userProviders[organization.url];

                if (!providerExists) user.providerData[organization.url] = aafAttributes;

                if (organization) {
                    const orgExists = user.organizations.find(e => {
                        if (e) {
                            return e._id.equals(organization._id);
                        }
                    });
                    if (!orgExists) user.organizations.push(organization._id);
                }
                console.log('found existing user');
                // user exists update ITA and return user
                if (user.jti && user.jti === profile.jti) {
                    return done(new Error('ITA Match please login again'));
                }
                user.jti = profile.jti;
                return user.save();
            }
        })
        .then(user => {
            return done(null, user);
        })
        .catch(err => done(err));
};

/**
 * Helper function to save or update a OAuth user profile
 */
exports.saveOAuthUserProfile = function (req, providerUserProfile, done) {
    const organization = req.organization;
    if (!req.user) {
        // Define a search query fields
        const searchMainProviderIdentifierField =
            'providerData.' + providerUserProfile.providerIdentifierField;
        const searchAdditionalProviderIdentifierField =
            'additionalProvidersData.' +
            providerUserProfile.provider +
            '.' +
            providerUserProfile.providerIdentifierField;

        // Define main provider search query
        const mainProviderSearchQuery = {};
        mainProviderSearchQuery.provider = providerUserProfile.provider;
        mainProviderSearchQuery[searchMainProviderIdentifierField] =
            providerUserProfile.providerData[
                providerUserProfile.providerIdentifierField
            ];

        // Define additional provider search query
        const additionalProviderSearchQuery = {};
        additionalProviderSearchQuery[searchAdditionalProviderIdentifierField] =
            providerUserProfile.providerData[
                providerUserProfile.providerIdentifierField
            ];

        // Define a search query to find existing user with current provider profile
        const searchQuery = {
            $or: [mainProviderSearchQuery, additionalProviderSearchQuery]
        };

        User.findOne(searchQuery, function (err, user) {
            if (err) {
                return done(err);
            } else {
                if (!user) {
                    const possibleUsername =
                        providerUserProfile.username ||
                        (providerUserProfile.email ?
                            providerUserProfile.email.split('@')[0] :
                            '');

                    User.findUniqueUsername(possibleUsername, null, function (
                        availableUsername
                    ) {
                        user = new User({
                            firstName: providerUserProfile.firstName,
                            lastName: providerUserProfile.lastName,
                            username: availableUsername,
                            displayName: providerUserProfile.displayName,
                            email: providerUserProfile.email,
                            profileImageURL: providerUserProfile.profileImageURL,
                            provider: providerUserProfile.provider,
                            providerData: providerUserProfile.providerData,
                            organizations: [organization._id]
                        });

                        // And save the user
                        user.save(function (err) {
                            return done(err, user);
                        });
                    });
                } else {
                    const orgExists = user.organizations.find(e => {
                        return e._id.equals(organization._id);
                    });
                    if (!orgExists) user.organizations.push(organization._id);
                    user.save();
                    return done(err, user);
                }
            }
        });
    } else {
        // User is already logged in, join the provider data to the existing user
        const user = req.user;

        const orgExists = user.organizations.find(e => {
            return e._id.equals(organization._id);
        });
        if (!orgExists) user.organizations.push(organization._id);

        // Check if user exists, is not signed in using this provider, and doesn't have that provider data already configured
        if (
            user.provider !== providerUserProfile.provider &&
            (!user.additionalProvidersData ||
                !user.additionalProvidersData[providerUserProfile.provider])
        ) {
            // Add the provider data to the additional provider data field
            if (!user.additionalProvidersData) {
                user.additionalProvidersData = {};
            }

            user.additionalProvidersData[providerUserProfile.provider] =
                providerUserProfile.providerData;

            // Then tell mongoose that we've updated the additionalProvidersData field
            user.markModified('additionalProvidersData');

            // And save the user
            user.save(function (err) {
                return done(err, user, '/settings/accounts');
            });
        } else {
            user.save();
            return done(
                new Error('User is already connected using this provider'),
                user
            );
        }
    }
};

/**
 * Remove OAuth provider
 */
exports.removeOAuthProvider = function (req, res, next) {
    const user = req.user;
    const provider = req.query.provider;

    if (!user) {
        return res.status(401).json({
            message: 'User is not authenticated'
        });
    } else if (!provider) {
        return res.status(400).send();
    }

    // Delete the additional provider
    if (user.additionalProvidersData[provider]) {
        delete user.additionalProvidersData[provider];

        // Then tell mongoose that we've updated the additionalProvidersData field
        user.markModified('additionalProvidersData');
    }

    user.save(function (err) {
        if (err) {
            return res.status(400).send({
                message: errorHandler.getErrorMessage(err)
            });
        } else {
            req.login(user, function (err) {
                if (err) {
                    return res.status(400).send(err);
                } else {
                    return res.json(user);
                }
            });
        }
    });
};

/**
 * Makes sure the user has the correct orgs listed
 * any time a user votes they are considered a member of an org
 **/
exports.updateOrgs = function (loginData) {
    // get the actual user from the db
    User.findOne({
        _id: loginData._id
    }).then(user => {
        if (user) {
            // get all the votes for this user
            Vote.find({
                user
            })
                .populate('object')
                .then(votes => {
                    if (votes) {
                        // get a list of orgs from all of the votes
                        let orgs = votes.reduce((accum, v) => {
                            if (v.object.organizations) {
                                accum.push(v.object.organizations._id);
                            }
                            return accum;
                        }, []);
                        // merge list of orgs into users orgs
                        orgs = orgs.concat(user.organizations);
                        // make sure they are all unique
                        orgs = _.uniqBy(orgs, 'generationTime');

                        // now add them to the users orgs and save
                        user.organizations = orgs;
                        user.save();
                    }
                });
        }
    });
};

exports.updateAllOrgs = function () {
    User.find()
        .exec()
        .then(users => {
            users.forEach(user => {
                Vote.find({
                    user: user._id
                })
                    .populate('object')
                    .then(populatedVotes => {
                        let orgs = populatedVotes.reduce((accum, v) => {
                            if (v.object && v.object.organizations) {
                                accum.push(v.object.organizations._id);
                            }
                            return accum;
                        }, []);

                        // merge list of orgs into users orgs
                        orgs = orgs.concat(user.organizations);
                        // make sure they are all unique
                        orgs = _.uniqBy(orgs, 'generationTime');

                        user.organizations = orgs;
                        user.save();
                    });
            });
        });
};

function handleLeaderVerification(user, verificationCode) {
    const {
        email
    } = user;

    return FutureLeader.findOne({
        email
    })
        .populate('organizations')
        .then(leader => {
            if (!leader) throw 'Email does not match Verification Code';
            if (!leader.verify(verificationCode))
                throw 'Invalid Verification Code, please check and try again';

            return leader;
        })
        .then(leader => {
            let {
                organizations
            } = leader;

            // leader has no organizations to be assigned to
            if (organizations.length === 0) {
                leader.remove();
                return user.save();
            }

            organizations.forEach(org => {
                if (org.futureOwner && org.futureOwner.equals(leader._id)) {
                    org.owner = user._id;
                    org.futureOwner = null;
                    return org.save();
                }
                return org;
            });

            user.organizations = organizations;
            // Future leader can be removed from database
            leader.remove();
            return user.save();
        })
        .catch(err => {
            console.log(err, 'this is err');
            throw 'Error during verification';
        });
}

function loginUser(req, res, user) {
    return req.login(user, function (err) {
        if (err) {
            return res.status(400).send(err);
        } else {
            const payload = {
                _id: user._id,
                roles: user.roles,
                verified: user.verified
            };
            const token = jwt.sign(payload, config.jwtSecret, {
                expiresIn: config.jwtExpiry
            });
            return res.json({
                user: user,
                token: token
            });
        }
    });
}
