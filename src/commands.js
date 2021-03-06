var _ = require('lodash');

var last_info = {};
var rate_limit = {};

function replaceFactoidPlaceholders (factoid, triggered, bot, route) {
	// Replace who and what with the triggerer and the match
	factoid = factoid.replace(/\$who/ig, route.nick);
	if (triggered) factoid = factoid.replace(/\$what/ig, triggered.match[1]);

	// Chose random people in the room
	var someone = /\$someone/i;
	while (someone.test(factoid)) {
		factoid = factoid.replace(someone, _.sample(bot.users.getRoomRoster(route.room)).nick);
	}

	// Some people like using $something instead of $item
	var something = /(\$something)/i;
	while (something.test(factoid)) {
		factoid = factoid.replace(something, bot.db.schemas.word.selectByType('$item'));
	}

	// Resolve remaining $placeholders
	_.forEach(bot.db.schemas.word.getTypes(), function (type) {
		// don't forget to add a slash before the $!!
		var regex = new RegExp('\\' + type, 'i');
		while (regex.test(factoid)) {
			factoid = factoid.replace(regex, bot.db.schemas.word.selectByType(type));
		}
	});

	return factoid;
}

module.exports = {
	learn : function (route, args) {
		var trigger = args.shift();
		var alias = false;
		var rex_trigger;

		if (!trigger) {
			route.send('?facts_trigger_missing');
			return;
		}

		if (trigger === 'alias') {
			alias = true;
			trigger = args.shift();
		}

		// Reject short triggers, add word boundaries to non-regex triggers.
		if (trigger[0] === '/') {
			if (trigger.length < 5) {
				route.send('?facts_trigger_short');
				return;
			}

			rex_trigger = trigger.replace(/\//g, '');
		} else {
			if (trigger.length < 3) {
				route.send('?facts_trigger_short');
				return;
			}
			rex_trigger =  '\\b' + trigger + '\\b';
		}

		// Write the alias or trigger.
		var remainder = args.join(' ');
		var promise;
		if (alias) {
			promise = this.db.schemas.factTrigger.saveAlias(rex_trigger, remainder);
		} else {
			promise = this.db.schemas.factTrigger.saveFactoid(rex_trigger, remainder, route.nick);
		}

		// Respond to user
		promise.then(function () {
			route.send('?facts_learned_fact', trigger, remainder);
		}, function (err) {
			console.log('Error learning fact:', err);
			route.send('?response_error', err);
		});
	},
	say : function (route, message) {
		
		var bot = this;
		var output = message.join(' ');

		console.log('Forced to say fact:', output);

		output = replaceFactoidPlaceholders(output, false, bot, route);

		route.indirect().send(output);
	},
	explain : function (route) {
		var channel = last_info[route.room] ? route.room : route.user._id.toString();
		if (last_info[channel]) {
			var out = 'That was "' + last_info[channel].factoid + '", triggered by "' + last_info[channel].match + '"';
			if (last_info[channel].trigger !== '\\b' + last_info[channel].match + '\\b') {
				out += ' matching "' + last_info[channel].trigger + '"';
			}
			if (last_info[channel].author) {
				out += ', authored by ' + last_info[channel].author;
			}
			route.send(out);
		} else {
			route.send('I didn\'t do anything...');
		}
	},
	listener : function (route, message) {

		if (route.room && rate_limit[route.room] && rate_limit[route.room] > new Date()) {
			// Can't trigger, rate limited
			// Helps prevent two bots triggering off each other infinitely, or triggering multiple facts when entering a room.
			return false;
		}

		var bot = this;
		var triggered = this.db.schemas.factTrigger.checkMessage(message);

		if (triggered) {
			// Set rate limit in room
			if (route.room) {
				var limit = new Date();
				limit.setSeconds(limit.getSeconds() + 1);
				rate_limit[route.room] = limit;
			}

			var trigger = triggered.trigger;

			// Set new timeout
			trigger.timeout = new Date();
			trigger.timeout.setMinutes(trigger.timeout.getMinutes() + Math.floor(Math.random() * 5) + 5);

			// Get, process, and send the factoid
			trigger.getFactoid().then(function (factoid) {
				var output = factoid.factoid;

				console.log('Triggered raw fact:', output);

				// Save info about last triggered fact
				var last_info_obj = {
					factoid : factoid.factoid,
					author : factoid.author,
					trigger : triggered.trigger.trigger, //oh yes
					match : triggered.match[0]
				};

				if (route.room) {
					last_info[route.room] = last_info_obj;
				} else {
					last_info[route.user._id.toString()] = last_info_obj;
				}

				output = replaceFactoidPlaceholders(output, triggered, bot, route);

				route.indirect().send(output);
			}, function (err) {
				console.log('Error getting factoid:', err);
			});
			return true;
		} else {
			return false;
		}
	},
	have : function (route, args) {
		var bot = this;
		var type = args.shift();

		if (type[0] !== '$') {
			args.unshift(type);
			type = '$item';
		} else if (type === '$something' || type === 'item') {
			// handle silly users
			type = '$item';
		}

		var word = args.join(' ');

		bot.db.schemas.word.createIfNotExists({ type : type, word : word }).then(function () {
			if (type === '$item') {
				route.send('Thanks for ' + word + '!');
			} else {
				route.send('Adding ' + word + ' to ' + type + ' list.');
			}
		}, function (err) {
			console.log('Error adding word:', err);
			route.send('Error adding word:', err);
		});
	}
};
