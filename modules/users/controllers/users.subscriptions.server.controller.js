'use strict';

/**
 * Module dependencies.
 */
let _ = require('lodash'),
    path = require('path'),
    config = require(path.resolve('./config/config')),
    mongoose = require('mongoose'),
    User = mongoose.model('User'),
    errorHandler = require(path.resolve(
        './modules/core/errors.server.controller'
    )),
    webPush = require('web-push');


const options = {
    vapidDetails: {
        subject: 'https://newvote.org',
        publicKey: config.vapid.VAPID_PUB,
        privateKey: config.vapid.VAPID_PRIV
    },
    TTL: 60
}

exports.create = (req, res) => {
    const { subscriptionId: id } = req.params
    const { endpoint, expirationTime, keys } = req.body
    const subscription = {
        endpoint,
        expirationTime,
        keys
    }

    User.findOne({ _id: id })
        .then((user) => {
            if (!user) throw('User does not exist')

            let subscriptions = user.subscriptions || {}

            if (!subscriptions[req.organization.url]) {
                subscriptions[req.organization.url] = subscription
            }

            _.merge(subscriptions[req.organization.url], subscription)
            user.subscriptions[req.organization.url] = subscriptions

            let path = 'subscriptions' + '.' + req.organization.url
            user.markModified(path)

            // let path = 'subscriptions' + '.' + req.organization.url
            // user.markModified(path)
            return user.save()
        })
        .then((user) => {
            return res.json(user.subscriptions);
        })
        .catch((err) => {
            return res.status(400).send({
                message: errorHandler.getErrorMessage(err)
            });
        })
}

exports.update = (req, res) => {
    const { _id: id } = req.user
    const { subscription } = req.body

    User.findOne({ _id: id })
        .then((user) => {
            if (!user) throw('User does not exist')
        })
        .catch((err) => {
            return res.status(400).send({
                message: errorHandler.getErrorMessage(err)
            });
        })
}

exports.delete = (req, res) => {
    const { _id: id } = req.user
    const { subscription } = req.body

    User.findOne({ _id: id })
        .then((user) => {
            if (!user) throw('User does not exist')
        })
        .catch((err) => {
            return res.status(400).send({
                message: errorHandler.getErrorMessage(err)
            });
        })
}

exports.test = (req, res) => {
    const { url } = req.organization
    const { subscriptionId: id } = req.params
    const { title, description } = req.body
    const notificationPayload = {
        "notification": {
            "title": "Angular News",
            "body": "Newsletter Available!",
            "vibrate": [100, 50, 100],
            "data": {
                "dateOfArrival": Date.now(),
                "primaryKey": 1
            },
            "actions": [{
                "action": "explore",
                "title": "Go to the site"
            }]
        }
    };

    User.findOne({ _id: id })
        .then((user) => {
            if (!user.subscriptions[req.organization.url]) throw('User is not subscribed to organization')
            const subscription = user.subscriptions[req.organization.url]
            return webPush.sendNotification(subscription, JSON.stringify(notificationPayload), options)
        })
        .then((data) => {
            return res.json(data)
        })
        .catch((err) => {
            return res.status(400).send({
                message: errorHandler.getErrorMessage(err)
            });    
        })
}

