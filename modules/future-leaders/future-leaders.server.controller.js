'use strict';

/**
 * Module dependencies.
 */
var path = require('path'),
	config = require(path.resolve('./config/config')),
	mongoose = require('mongoose'),
	Organization = mongoose.model('Organization'),
	User = mongoose.model('User'),
	FutureLeader = mongoose.model('FutureLeader'),
	errorHandler = require(path.resolve('./modules/core/errors.server.controller')),
	_ = require('lodash'),
	nodemailer = require('nodemailer'),
	transporter = nodemailer.createTransport(config.mailer.options);


exports.update = function (req, res) {

	const { organizationId } = req.params
	const { futureOwner: email } = req.body;

	if (!organizationId || !email) {
		return res.status(400)
			.send({
				message: 'Email / ID does not exist on query'
			})
	}

	// Find if the email exists on either future leaders / users and reject or create new futureLeader
	const createLeaderPromise = User.find({ email })
		.then((user) => {
			if (user.length > 0) throw('User exists on database');			
			return FutureLeader.find({ email });
		})
		.then((leader) => {
			if (leader.length > 0) throw('Leader already exists on database');

			const owner = new FutureLeader({ email, organization: organizationId });
			
			// Had issues with the doc not saving before promise was resolve for promise.all
			// included an extra then seems to have fixed
			return owner
				.save()
				.then((doc) => {
					return doc;
				});
		})
	const findOrganizationPromise = Organization.findOne({ _id: organizationId })

	return Promise.all([createLeaderPromise, findOrganizationPromise])
		.then(promises => {
			let [leader, organization] = promises;
			if (!organization) {
				console.log(organization, 'this is org');
				throw('No organization')
			}
			if (!leader) {
				console.log(leader, 'this is leader');
				throw('No leader');
			}

			
			

			organization.owner = null;
			organization.futureOwner = leader._id;

			organization.save(function (err) {
				if (err) throw(err);
			});

			// Create and send an email to the user
			return sendVerificationCodeViaEmail(req, res, leader);
		})
		.catch((err) => {
			console.log(err, 'this is err');
			return res.status(400)
					.send({
						message: errorHandler.getErrorMessage(err)
					});
		})
};

var buildMessage = function (user, code, req) {
	var messageString = '';
	var url = req.protocol + '://' + req.get('host') + 'auth/signup/' + code;

	messageString += `<h3> You have been invited to join NewVote </h3>`;
	messageString += `<p>To complete your account setup, just click the URL below or copy and paste it into your browser's address bar</p>`;
	messageString += `<p><a href='${url}'>${url}</a></p>`;

	console.log(messageString, 'this is messageString');
	return messageString;
};

var sendEmail = function (user, pass, req) {
	return transporter.sendMail({
		from: process.env.MAILER_FROM,
		to: user.email,
		subject: 'NewVote UQU Verification',
		html: buildMessage(user, pass, req)
	})
}

function saveEmailVerificationCode(user, code) {

	return FutureLeader.findById(user._id)
		.then((user) => {
			if(!user) {
				throw Error('We could not find the user in the database. Please contact administration.');
			}
			//add hashed code to users model
			user.verificationCode = user.hashVerificationCode(code);

			//update user model
			return user.save();			
        })
		.then(() => code)
}

function sendVerificationCodeViaEmail (req, res, user) {
	var pass$ = FutureLeader.generateRandomPassphrase()

	//send code via email
	return pass$.then(pass => saveEmailVerificationCode(user, pass))
		.then(pass => sendEmail(user, pass, req))
		.then((data) => {
			console.log('Succesfully sent a verification e-mail: ', data);
			return res.status(200)
				.send({ message: 'success' })
		})
		.catch((err) => {
			console.log('error sending verification email: ', err);
			return res.status(400)
				.send({
					message: 'There was a problem while sending your verification e-mail, please try again later.'
				});
		});
};





