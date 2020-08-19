import { Match } from 'meteor/check';
import _ from 'underscore';
import deepMapKeys from 'deep-map-keys';
import { EJSON } from 'meteor/ejson';

import { Base } from './_Base';
import Rooms from './Rooms';
import { settings } from '../../../settings/server/functions/settings';
import { RoomEvents } from './RoomEvents';
import { getLocalSrc } from '../../../events/server/lib/getLocalSrc';
import { RoomEventTypeDescriptor } from '../../../events/definitions/room/IRoomEvent';

export class Messages extends Base {
	constructor() {
		super('message');

		this.tryEnsureIndex({ rid: 1, ts: 1, _updatedAt: 1 });
		this.tryEnsureIndex({ ts: 1 });
		this.tryEnsureIndex({ 'u._id': 1 });
		this.tryEnsureIndex({ editedAt: 1 }, { sparse: true });
		this.tryEnsureIndex({ 'editedBy._id': 1 }, { sparse: true });
		this.tryEnsureIndex({ rid: 1, t: 1, 'u._id': 1 });
		this.tryEnsureIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
		this.tryEnsureIndex({ msg: 'text' });
		this.tryEnsureIndex({ 'file._id': 1 }, { sparse: true });
		this.tryEnsureIndex({ 'mentions.username': 1 }, { sparse: true });
		this.tryEnsureIndex({ pinned: 1 }, { sparse: true });
		this.tryEnsureIndex({ snippeted: 1 }, { sparse: true });
		this.tryEnsureIndex({ location: '2dsphere' });
		this.tryEnsureIndex({ slackBotId: 1, slackTs: 1 }, { sparse: true });
		this.tryEnsureIndex({ unread: 1 }, { sparse: true });

		// discussions
		this.tryEnsureIndex({ drid: 1 }, { sparse: true });
		// threads
		this.tryEnsureIndex({ tmid: 1 }, { sparse: true });
		this.tryEnsureIndex({ tcount: 1, tlm: 1 }, { sparse: true });
		// livechat
		this.tryEnsureIndex({ 'navigation.token': 1 }, { sparse: true });
	}

	registerEventDispatcher(callback) {
		this.dispatchEvent = callback;
	}

	setReactions(messageId, reactions) {
		return this.update({ _id: messageId }, { $set: { reactions } });
	}

	keepHistoryForToken(token) {
		return this.update({
			'navigation.token': token,
			expireAt: {
				$exists: true,
			},
		}, {
			$unset: {
				expireAt: 1,
			},
		}, {
			multi: true,
		});
	}

	setRoomIdByToken(token, rid) {
		return this.update({
			'navigation.token': token,
			rid: null,
		}, {
			$set: {
				rid,
			},
		}, {
			multi: true,
		});
	}

	//
	// Overriding some methods to add V1<->V2 conversion
	//
	getV2Query(query) {
		let clid;

		if (query._id) {
			clid = query._id;

			query.clid = clid;
			delete query._id;
		}

		if (query.rid) {
			query.cid = query.rid;
			delete query.rid;
		}

		const v2Query = {};

		for (const item in query) {
			if (item.startsWith('$')) { continue; }

			if (RoomEvents.belongsToV2Root(item)) {
				v2Query[item] = query[item];
			} else {
				v2Query[`d.${ item }`] = query[item];
			}
		}

		if (query._updatedAt) {
			v2Query.updatedAt = query._updatedAt;
		}

		v2Query.t = query.t || 'msg';
		v2Query.deletedAt = query._deletedAt || null;

		return { clid, v2Query };
	}

	findV1(...args) {
		return this.model.rawCollection().find(...args);
	}

	removeV1(...args) {
		return this.model.rawCollection().remove(...args);
	}

	find(...args) {
		args[0] = args[0] || {};

		const { v2Query } = this.getV2Query(args[0]);

		args[0] = v2Query;

		// Add a `t: msg` and not deleted
		args[0].t = RoomEventTypeDescriptor.MESSAGE;

		const cursor = RoomEvents.find.apply(RoomEvents, args);

		cursor._fetch = cursor.fetch;
		cursor.fetch = function(...args) {
			const results = this._fetch(args);

			// Convert to V1
			return results.map(RoomEvents.toV1);
		}.bind(cursor);

		return cursor;
	}

	_findOne(...args) {
		args[0] = args[0] || {};

		const { v2Query } = this.getV2Query(args[0]);

		args[0] = v2Query;

		let result = RoomEvents.findOne.apply(RoomEvents, args);

		if (result) {
			result = RoomEvents.toV1(result);
		}

		return result;
	}

	findOne(...args) {
		return this._findOne(...args);
	}

	findOneById(...args) {
		return this._findOne({ clid: args[0] });
	}

	findOneByIds(ids, options, ...args) {
		return this._findOne([{ clid: { $in: ids } }, options, ...args]);
	}

	processEvents(query, processor) {
		const { v2Query } = this.getV2Query(query);

		const events = RoomEvents.find(v2Query).fetch();

		if (!events.length) {
			return null;
		}

		const result = [];

		for (const event of events) {
			result.push(processor(event));
		}

		return result.length === 1 ? result[0] : result;
	}

	insert(...args) {
		console.time('Messages.insert');
		const [message] = args;

		console.time('fromV1Data');
		const v2Data = RoomEvents.fromV1Data(message);
		console.timeEnd('fromV1Data');

		console.time('createMessageEvent');

		console.time('getLocalSrc');
		const localSrc = getLocalSrc();
		console.timeEnd('getLocalSrc');

		const event = Promise.await((async () => {
			console.time('inside');
			const data = await RoomEvents.createMessageEvent(localSrc, message.rid, message._id, v2Data);
			console.timeEnd('inside');
			return data;
		})());

		// const event = Promise.await(RoomEvents.createMessageEvent(localSrc, message.rid, message._id, v2Data));
		console.timeEnd('createMessageEvent');

		console.time('dispatchEvent');
		Promise.await(this.dispatchEvent(event));
		console.timeEnd('dispatchEvent');

		console.time('toV1');
		const v1 = RoomEvents.toV1(event)._id;
		console.timeEnd('toV1');

		console.timeEnd('Messages.insert');

		return v1;
	}

	update(...args) {
		const [query, update] = args;

		return this.processEvents(query, (event) => {
			const d = deepMapKeys(EJSON.toJSONValue(update), (k) => k.replace('$', '[csg]').replace('.', '[dot]'));
			d['[csg]set'] = d['[csg]set'] || {};
			d['[csg]set']._oid = event._id; // Original id

			const editEvent = Promise.await(RoomEvents.createEditMessageEvent(event.src, event.cid, event.clid, d));

			Promise.await(this.dispatchEvent(editEvent));

			return RoomEvents.toV1(editEvent);
		});
	}

	upsert(...args) {
		const [query] = args;

		const event = RoomEvents.findOne(query);

		if (event) {
			return this.update(...args);
		}

		return this.insert(...args);
	}

	remove(...args) {
		const [query] = args;

		return this.processEvents(query, (event) => {
			const deleteEvent = Promise.await(RoomEvents.createDeleteMessageEvent(event.src, event.cid, event.clid));

			Promise.await(this.dispatchEvent(deleteEvent));

			return RoomEvents.toV1(deleteEvent);
		});
	}

	trashFind(query, options) {
		query._deletedAt = { $ne: null };

		return this.find(query, options);
	}

	trashFindOneById(_id, options) {
		const query = {
			_id,
			_deletedAt: { $ne: null },
		};

		return this.findOne(query, options);
	}

	trashFindDeletedAfter(deletedAt, query = {}, options) {
		query._deletedAt = {
			$ne: null,
			$gt: deletedAt,
		};

		return this.find(query, options);
	}
	//
	// ^^^
	//

	createRoomArchivedByRoomIdAndUser(roomId, user) {
		return this.createWithTypeRoomIdMessageAndUser('room-archived', roomId, '', user);
	}

	createRoomUnarchivedByRoomIdAndUser(roomId, user) {
		return this.createWithTypeRoomIdMessageAndUser('room-unarchived', roomId, '', user);
	}

	unsetReactions(messageId) {
		return this.update({ _id: messageId }, { $unset: { reactions: 1 } });
	}

	deleteOldOTRMessages(roomId, ts) {
		const query = { rid: roomId, t: 'otr', ts: { $lte: ts } };
		return this.remove(query);
	}

	updateOTRAck(_id, otrAck) {
		const query = { _id };
		const update = { $set: { otrAck } };
		return this.update(query, update);
	}

	setGoogleVisionData(messageId, visionData) {
		const updateObj = {};
		for (const index in visionData) {
			if (visionData.hasOwnProperty(index)) {
				updateObj[`attachments.0.${ index }`] = visionData[index];
			}
		}

		return this.update({ _id: messageId }, { $set: updateObj });
	}

	createRoomSettingsChangedWithTypeRoomIdMessageAndUser(type, roomId, message, user, extraData) {
		return this.createWithTypeRoomIdMessageAndUser(type, roomId, message, user, extraData);
	}

	createRoomRenamedWithRoomIdRoomNameAndUser(roomId, roomName, user, extraData) {
		return this.createWithTypeRoomIdMessageAndUser('r', roomId, roomName, user, extraData);
	}

	addTranslations(messageId, translations, providerName) {
		const updateObj = { translationProvider: providerName };
		Object.keys(translations).forEach((key) => {
			const translation = translations[key];
			updateObj[`translations.${ key }`] = translation;
		});
		return this.update({ _id: messageId }, { $set: updateObj });
	}

	addAttachmentTranslations = function(messageId, attachmentIndex, translations) {
		const updateObj = {};
		Object.keys(translations).forEach((key) => {
			const translation = translations[key];
			updateObj[`attachments.${ attachmentIndex }.translations.${ key }`] = translation;
		});
		return this.update({ _id: messageId }, { $set: updateObj });
	}

	setImportFileRocketChatAttachment(importFileId, rocketChatUrl, attachment) {
		const query = {
			'_importFile.id': importFileId,
		};

		return this.update(query, {
			$set: {
				'_importFile.rocketChatUrl': rocketChatUrl,
				'_importFile.downloaded': true,
			},
			$addToSet: {
				attachments: attachment,
			},
		}, { multi: true });
	}

	countVisibleByRoomIdBetweenTimestampsInclusive(roomId, afterTimestamp, beforeTimestamp, options) {
		const query = {
			_hidden: {
				$ne: true,
			},
			rid: roomId,
			ts: {
				$gte: afterTimestamp,
				$lte: beforeTimestamp,
			},
		};

		return this.find(query, options).count();
	}

	// FIND
	findByMention(username, options) {
		const query = { 'mentions.username': username };

		return this.find(query, options);
	}

	findFilesByUserId(userId, options = {}) {
		const query = {
			'u._id': userId,
			'file._id': { $exists: true },
		};
		return this.find(query, { fields: { 'file._id': 1 }, ...options });
	}

	findFilesByRoomIdPinnedTimestampAndUsers(rid, excludePinned, ignoreDiscussion = true, ts, users = [], ignoreThreads = true, options = {}) {
		const query = {
			rid,
			ts,
			'file._id': { $exists: true },
		};

		if (excludePinned) {
			query.pinned = { $ne: true };
		}

		if (ignoreThreads) {
			query.tmid = { $exists: 0 };
			query.tcount = { $exists: 0 };
		}

		if (ignoreDiscussion) {
			query.drid = { $exists: 0 };
		}

		if (users.length) {
			query['u.username'] = { $in: users };
		}

		return this.find(query, { fields: { 'file._id': 1 }, ...options });
	}

	findDiscussionByRoomIdPinnedTimestampAndUsers(rid, excludePinned, ts, users = [], options = {}) {
		const query = {
			rid,
			ts,
			drid: { $exists: 1 },
		};

		if (excludePinned) {
			query.pinned = { $ne: true };
		}

		if (users.length) {
			query['u.username'] = { $in: users };
		}

		return this.find(query, options);
	}

	findVisibleByMentionAndRoomId(username, rid, options) {
		const query = {
			_hidden: { $ne: true },
			'mentions.username': username,
			rid,
		};

		return this.find(query, options);
	}

	findVisibleByRoomId(rid, options) {
		const query = {
			_hidden: {
				$ne: true,
			},

			rid,
		};

		return this.find(query, options);
	}

	findVisibleThreadByThreadId(tmid, options) {
		const query = {
			_hidden: {
				$ne: true,
			},

			tmid,
		};

		return this.find(query, options);
	}

	findVisibleByRoomIdNotContainingTypes(roomId, types, options) {
		const query = {
			_hidden: {
				$ne: true,
			},
			rid: roomId,
		};

		if (Match.test(types, [String]) && (types.length > 0)) {
			query.t = { $nin: types };
		}

		return this.find(query, options);
	}

	findInvisibleByRoomId(roomId, options) {
		const query = {
			_hidden: true,
			rid: roomId,
		};

		return this.find(query, options);
	}

	findVisibleByRoomIdAfterTimestamp(roomId, timestamp, options) {
		const query = {
			_hidden: {
				$ne: true,
			},
			rid: roomId,
			ts: {
				$gt: timestamp,
			},
		};

		return this.find(query, options);
	}

	findForUpdates(roomId, timestamp, options) {
		const query = {
			_hidden: {
				$ne: true,
			},
			rid: roomId,
			_updatedAt: {
				$gt: timestamp,
			},
		};
		return this.find(query, options);
	}

	findVisibleByRoomIdBeforeTimestamp(roomId, timestamp, options) {
		const query = {
			_hidden: {
				$ne: true,
			},
			rid: roomId,
			ts: {
				$lt: timestamp,
			},
		};

		return this.find(query, options);
	}

	findVisibleByRoomIdBeforeTimestampInclusive(roomId, timestamp, options) {
		const query = {
			_hidden: {
				$ne: true,
			},
			rid: roomId,
			ts: {
				$lte: timestamp,
			},
		};

		return this.find(query, options);
	}

	findVisibleByRoomIdBetweenTimestamps(roomId, afterTimestamp, beforeTimestamp, options) {
		const query = {
			_hidden: {
				$ne: true,
			},
			rid: roomId,
			ts: {
				$gt: afterTimestamp,
				$lt: beforeTimestamp,
			},
		};

		return this.find(query, options);
	}

	findVisibleByRoomIdBetweenTimestampsInclusive(roomId, afterTimestamp, beforeTimestamp, options) {
		const query = {
			_hidden: {
				$ne: true,
			},
			rid: roomId,
			ts: {
				$gte: afterTimestamp,
				$lte: beforeTimestamp,
			},
		};

		return this.find(query, options);
	}

	findVisibleByRoomIdBeforeTimestampNotContainingTypes(roomId, timestamp, types, options) {
		const query = {
			_hidden: {
				$ne: true,
			},
			rid: roomId,
			ts: {
				$lt: timestamp,
			},
		};

		if (Match.test(types, [String]) && (types.length > 0)) {
			query.t = { $nin: types };
		}

		return this.find(query, options);
	}

	findVisibleByRoomIdBetweenTimestampsNotContainingTypes(roomId, afterTimestamp, beforeTimestamp, types, options) {
		const query = {
			_hidden: {
				$ne: true,
			},
			rid: roomId,
			ts: {
				$gt: afterTimestamp,
				$lt: beforeTimestamp,
			},
		};

		if (Match.test(types, [String]) && (types.length > 0)) {
			query.t = { $nin: types };
		}

		return this.find(query, options);
	}

	findVisibleCreatedOrEditedAfterTimestamp(timestamp, options) {
		const query = {
			_hidden: { $ne: true },
			$or: [{
				ts: {
					$gt: timestamp,
				},
			},
			{
				editedAt: {
					$gt: timestamp,
				},
			},
			],
		};

		return this.find(query, options);
	}

	findStarredByUserAtRoom(userId, roomId, options) {
		const query = {
			_hidden: { $ne: true },
			'starred._id': userId,
			rid: roomId,
		};

		return this.find(query, options);
	}

	findPinnedByRoom(roomId, options) {
		const query = {
			t: { $ne: 'rm' },
			_hidden: { $ne: true },
			pinned: true,
			rid: roomId,
		};

		return this.find(query, options);
	}

	findSnippetedByRoom(roomId, options) {
		const query = {
			_hidden: { $ne: true },
			snippeted: true,
			rid: roomId,
		};

		return this.find(query, options);
	}

	getLastTimestamp(options) {
		if (options == null) { options = {}; }
		const query = { ts: { $exists: 1 } };
		options.sort = { ts: -1 };
		options.limit = 1;
		const [message] = this.find(query, options).fetch();
		return message && message.ts;
	}

	findByRoomIdAndMessageIds(rid, messageIds, options) {
		const query = {
			rid,
			_id: {
				$in: messageIds,
			},
		};

		return this.find(query, options);
	}

	findOneBySlackBotIdAndSlackTs(slackBotId, slackTs) {
		const query = {
			slackBotId,
			slackTs,
		};

		return this.findOne(query);
	}

	findOneBySlackTs(slackTs) {
		const query = { slackTs };

		return this.findOne(query);
	}

	findByRoomIdAndType(roomId, type, options) {
		const query = {
			rid: roomId,
			t: type,
		};

		if (options == null) { options = {}; }

		return this.find(query, options);
	}

	findByRoomId(roomId, options) {
		const query = {
			rid: roomId,
		};

		return this.find(query, options);
	}

	getLastVisibleMessageSentWithNoTypeByRoomId(rid, messageId) {
		const query = {
			rid,
			_hidden: { $ne: true },
			t: { $exists: false },
			$or: [
				{ tmid: { $exists: false } },
				{ tshow: true },
			],
		};

		if (messageId) {
			query._id = { $ne: messageId };
		}

		const options = {
			sort: {
				ts: -1,
			},
		};

		return this.findOne(query, options);
	}

	cloneAndSaveAsHistoryById(_id, user) {
		const record = this.findOneById(_id);
		record._hidden = true;
		record.parent = record._id;
		record.editedAt = new Date();
		record.editedBy = {
			_id: user._id,
			username: user.username,
		};
		delete record._id;
		return this.insert(record);
	}

	// UPDATE
	setHiddenById(_id, hidden) {
		if (hidden == null) { hidden = true; }
		const query = { _id };

		const update = {
			$set: {
				_hidden: hidden,
			},
		};

		return this.update(query, update);
	}

	setAsDeletedByIdAndUser(_id, user) {
		const query = { _id };

		const update = {
			$set: {
				msg: '',
				t: 'rm',
				urls: [],
				mentions: [],
				attachments: [],
				reactions: [],
				editedAt: new Date(),
				editedBy: {
					_id: user._id,
					username: user.username,
				},
			},
			$unset: {
				blocks: 1,
			},
		};

		return this.update(query, update);
	}

	setPinnedByIdAndUserId(_id, pinnedBy, pinned, pinnedAt) {
		if (pinned == null) { pinned = true; }
		if (pinnedAt == null) { pinnedAt = 0; }
		const query = { _id };

		const update = {
			$set: {
				pinned,
				pinnedAt: pinnedAt || new Date(),
				pinnedBy,
			},
		};

		return this.update(query, update);
	}

	setSnippetedByIdAndUserId(message, snippetName, snippetedBy, snippeted, snippetedAt) {
		if (snippeted == null) { snippeted = true; }
		if (snippetedAt == null) { snippetedAt = 0; }
		const query = { _id: message._id };

		const msg = `\`\`\`${ message.msg }\`\`\``;

		const update = {
			$set: {
				msg,
				snippeted,
				snippetedAt: snippetedAt || new Date(),
				snippetedBy,
				snippetName,
			},
		};

		return this.update(query, update);
	}

	setUrlsById(_id, urls) {
		const query = { _id };

		const update = {
			$set: {
				urls,
			},
		};

		return this.update(query, update);
	}

	updateAllUsernamesByUserId(userId, username) {
		const query = { 'u._id': userId };

		const update = {
			$set: {
				'u.username': username,
			},
		};

		return this.update(query, update, { multi: true });
	}

	updateUsernameOfEditByUserId(userId, username) {
		const query = { 'editedBy._id': userId };

		const update = {
			$set: {
				'editedBy.username': username,
			},
		};

		return this.update(query, update, { multi: true });
	}

	updateUsernameAndMessageOfMentionByIdAndOldUsername(_id, oldUsername, newUsername, newMessage) {
		const query = {
			_id,
			'mentions.username': oldUsername,
		};

		const update = {
			$set: {
				'mentions.$.username': newUsername,
				msg: newMessage,
			},
		};

		return this.update(query, update);
	}

	updateUserStarById(_id, userId, starred) {
		let update;
		const query = { _id };

		if (starred) {
			update = {
				$addToSet: {
					starred: { _id: userId },
				},
			};
		} else {
			update = {
				$pull: {
					starred: { _id: userId },
				},
			};
		}

		return this.update(query, update);
	}

	upgradeEtsToEditAt() {
		const query = { ets: { $exists: 1 } };

		const update = {
			$rename: {
				ets: 'editedAt',
			},
		};

		return this.update(query, update, { multi: true });
	}

	setMessageAttachments(_id, attachments) {
		const query = { _id };

		const update = {
			$set: {
				attachments,
			},
		};

		return this.update(query, update);
	}

	setSlackBotIdAndSlackTs(_id, slackBotId, slackTs) {
		const query = { _id };

		const update = {
			$set: {
				slackBotId,
				slackTs,
			},
		};

		return this.update(query, update);
	}

	unlinkUserId(userId, newUserId, newUsername, newNameAlias) {
		const query = {
			'u._id': userId,
		};

		const update = {
			$set: {
				alias: newNameAlias,
				'u._id': newUserId,
				'u.username': newUsername,
				'u.name': undefined,
			},
		};

		return this.update(query, update, { multi: true });
	}

	// INSERT
	createWithTypeRoomIdMessageAndUser(type, roomId, message, user, extraData) {
		const record = {
			t: type,
			rid: roomId,
			ts: new Date(),
			msg: message,
			u: {
				_id: user._id,
				username: user.username,
			},
			groupable: false,
		};

		if (settings.get('Message_Read_Receipt_Enabled')) {
			record.unread = true;
		}

		_.extend(record, extraData);

		record._id = this.insert(record);
		Rooms.incMsgCountById(roomId, 1);
		return record;
	}

	createNavigationHistoryWithRoomIdMessageAndUser(roomId, message, user, extraData) {
		const type = 'livechat_navigation_history';
		const record = {
			t: type,
			rid: roomId,
			ts: new Date(),
			msg: message,
			u: {
				_id: user._id,
				username: user.username,
			},
			groupable: false,
		};

		if (settings.get('Message_Read_Receipt_Enabled')) {
			record.unread = true;
		}

		_.extend(record, extraData);

		record._id = this.insert(record);
		return record;
	}

	createTransferHistoryWithRoomIdMessageAndUser(roomId, message, user, extraData) {
		const type = 'livechat_transfer_history';
		const record = {
			t: type,
			rid: roomId,
			ts: new Date(),
			msg: message,
			u: {
				_id: user._id,
				username: user.username,
			},
			groupable: false,
		};

		if (settings.get('Message_Read_Receipt_Enabled')) {
			record.unread = true;
		}
		Object.assign(record, extraData);

		record._id = this.insert(record);
		return record;
	}

	createTranscriptHistoryWithRoomIdMessageAndUser(roomId, message, user, extraData) {
		const type = 'livechat_transcript_history';
		const record = {
			t: type,
			rid: roomId,
			ts: new Date(),
			msg: message,
			u: {
				_id: user._id,
				username: user.username,
			},
			groupable: false,
		};

		if (settings.get('Message_Read_Receipt_Enabled')) {
			record.unread = true;
		}
		Object.assign(record, extraData);

		record._id = this.insertOrUpsert(record);
		return record;
	}

	createUserJoinWithRoomIdAndUser(roomId, user, extraData) {
		const message = user.username;
		return this.createWithTypeRoomIdMessageAndUser('uj', roomId, message, user, extraData);
	}

	createUserJoinWithRoomIdAndUserDiscussion(roomId, user, extraData) {
		const message = user.username;
		return this.createWithTypeRoomIdMessageAndUser('ut', roomId, message, user, extraData);
	}

	createUserLeaveWithRoomIdAndUser(roomId, user, extraData) {
		const message = user.username;
		return this.createWithTypeRoomIdMessageAndUser('ul', roomId, message, user, extraData);
	}

	createUserRemovedWithRoomIdAndUser(roomId, user, extraData) {
		const message = user.username;
		return this.createWithTypeRoomIdMessageAndUser('ru', roomId, message, user, extraData);
	}

	createUserAddedWithRoomIdAndUser(roomId, user, extraData) {
		const message = user.username;
		return this.createWithTypeRoomIdMessageAndUser('au', roomId, message, user, extraData);
	}

	createCommandWithRoomIdAndUser(command, roomId, user, extraData) {
		return this.createWithTypeRoomIdMessageAndUser('command', roomId, command, user, extraData);
	}

	createUserMutedWithRoomIdAndUser(roomId, user, extraData) {
		const message = user.username;
		return this.createWithTypeRoomIdMessageAndUser('user-muted', roomId, message, user, extraData);
	}

	createUserUnmutedWithRoomIdAndUser(roomId, user, extraData) {
		const message = user.username;
		return this.createWithTypeRoomIdMessageAndUser('user-unmuted', roomId, message, user, extraData);
	}

	createNewModeratorWithRoomIdAndUser(roomId, user, extraData) {
		const message = user.username;
		return this.createWithTypeRoomIdMessageAndUser('new-moderator', roomId, message, user, extraData);
	}

	createModeratorRemovedWithRoomIdAndUser(roomId, user, extraData) {
		const message = user.username;
		return this.createWithTypeRoomIdMessageAndUser('moderator-removed', roomId, message, user, extraData);
	}

	createNewOwnerWithRoomIdAndUser(roomId, user, extraData) {
		const message = user.username;
		return this.createWithTypeRoomIdMessageAndUser('new-owner', roomId, message, user, extraData);
	}

	createOwnerRemovedWithRoomIdAndUser(roomId, user, extraData) {
		const message = user.username;
		return this.createWithTypeRoomIdMessageAndUser('owner-removed', roomId, message, user, extraData);
	}

	createNewLeaderWithRoomIdAndUser(roomId, user, extraData) {
		const message = user.username;
		return this.createWithTypeRoomIdMessageAndUser('new-leader', roomId, message, user, extraData);
	}

	createLeaderRemovedWithRoomIdAndUser(roomId, user, extraData) {
		const message = user.username;
		return this.createWithTypeRoomIdMessageAndUser('leader-removed', roomId, message, user, extraData);
	}

	createSubscriptionRoleAddedWithRoomIdAndUser(roomId, user, extraData) {
		const message = user.username;
		return this.createWithTypeRoomIdMessageAndUser('subscription-role-added', roomId, message, user, extraData);
	}

	createSubscriptionRoleRemovedWithRoomIdAndUser(roomId, user, extraData) {
		const message = user.username;
		return this.createWithTypeRoomIdMessageAndUser('subscription-role-removed', roomId, message, user, extraData);
	}

	// REMOVE
	removeById(_id) {
		const query = { _id };

		return this.remove(query);
	}

	removeByRoomId(roomId) {
		const query = { rid: roomId };

		return this.remove(query);
	}

	removeByRoomIds(rids) {
		return this.remove({ rid: { $in: rids } });
	}

	removeByIdPinnedTimestampLimitAndUsers(rid, pinned, ignoreDiscussion = true, ts, limit, users = [], ignoreThreads = true) {
		const query = {
			rid,
			ts,
		};

		if (pinned) {
			query.pinned = { $ne: true };
		}

		if (ignoreDiscussion) {
			query.drid = { $exists: 0 };
		}

		if (ignoreThreads) {
			query.tmid = { $exists: 0 };
			query.tcount = { $exists: 0 };
		}

		if (users.length) {
			query['u.username'] = { $in: users };
		}

		if (!limit) {
			const count = this.remove(query);

			// decrease message count
			Rooms.decreaseMessageCountById(rid, count);

			return count;
		}

		const messagesToDelete = this.find(query, {
			fields: {
				_id: 1,
			},
			limit,
		}).map(({ _id }) => _id);

		const count = this.remove({
			_id: {
				$in: messagesToDelete,
			},
		});

		// decrease message count
		Rooms.decreaseMessageCountById(rid, count);

		return count;
	}

	removeByUserId(userId) {
		const query = { 'u._id': userId };

		return this.remove(query);
	}

	getMessageByFileId(fileID) {
		return this.findOne({ 'file._id': fileID });
	}

	getMessageByFileIdAndUsername(fileID, userId) {
		const query = {
			'file._id': fileID,
			'u._id': userId,
		};

		const options = {
			fields: {
				unread: 0,
				mentions: 0,
				channels: 0,
				groupable: 0,
			},
		};

		return this.findOne(query, options);
	}

	setAsRead(rid, until) {
		return this.update({
			rid,
			unread: true,
			ts: { $lt: until },
		}, {
			$unset: {
				unread: 1,
			},
		}, {
			multi: true,
		});
	}

	setAsReadById(_id) {
		return this.update({
			_id,
		}, {
			$unset: {
				unread: 1,
			},
		});
	}

	findUnreadMessagesByRoomAndDate(rid, after) {
		const query = {
			unread: true,
			rid,
		};

		if (after) {
			query.ts = { $gt: after };
		}

		return this.find(query, {
			fields: {
				_id: 1,
			},
		});
	}

	/**
	 * Copy metadata from the discussion to the system message in the parent channel
	 * which links to the discussion.
	 * Since we don't pass this metadata into the model's function, it is not a subject
	 * to race conditions: If multiple updates occur, the current state will be updated
	 * only if the new state of the discussion room is really newer.
	 */
	refreshDiscussionMetadata({ rid }) {
		if (!rid) {
			return false;
		}
		const { lm: dlm, msgs: dcount } = Rooms.findOneById(rid, {
			fields: {
				msgs: 1,
				lm: 1,
			},
		});

		const query = {
			drid: rid,
		};

		return this.update(query, {
			$set: {
				dcount,
				dlm,
			},
		}, { multi: 1 });
	}

	// //////////////////////////////////////////////////////////////////
	// threads

	countThreads() {
		return this.find({ tcount: { $exists: true } }).count();
	}

	removeThreadRefByThreadId(tmid) {
		const query = { tmid };
		const update = {
			$unset: {
				tmid: 1,
			},
		};
		return this.update(query, update, { multi: true });
	}

	updateRepliesByThreadId(tmid, replies, ts) {
		const query = {
			_id: tmid,
		};

		const update = {
			$addToSet: {
				replies: {
					$each: replies,
				},
			},
			$set: {
				tlm: ts,
			},
			$inc: {
				tcount: 1,
			},
		};

		return this.update(query, update);
	}

	getThreadFollowsByThreadId(tmid) {
		const msg = this.findOneById(tmid, { fields: { replies: 1 } });
		return msg && msg.replies;
	}

	getFirstReplyTsByThreadId(tmid) {
		return this.findOne({ tmid }, { fields: { ts: 1 }, sort: { ts: 1 } });
	}

	unsetThreadByThreadId(tmid) {
		const query = {
			_id: tmid,
		};

		const update = {
			$unset: {
				tcount: 1,
				tlm: 1,
				replies: 1,
			},
		};

		return this.update(query, update);
	}

	updateThreadLastMessageAndCountByThreadId(tmid, tlm, tcount) {
		const query = {
			_id: tmid,
		};

		const update = {
			$set: {
				tlm,
			},
			$inc: {
				tcount,
			},
		};

		return this.update(query, update);
	}

	addThreadFollowerByThreadId(tmid, userId) {
		const query = {
			_id: tmid,
		};

		const update = {
			$addToSet: {
				replies: userId,
			},
		};

		return this.update(query, update);
	}

	removeThreadFollowerByThreadId(tmid, userId) {
		const query = {
			_id: tmid,
		};

		const update = {
			$pull: {
				replies: userId,
			},
		};

		return this.update(query, update);
	}

	findThreadsByRoomId(rid, skip, limit) {
		return this.find({ rid, tcount: { $exists: true } }, { sort: { tlm: -1 }, skip, limit });
	}

	findAgentLastMessageByVisitorLastMessageTs(roomId, visitorLastMessageTs) {
		const query = {
			rid: roomId,
			ts: { $gt: visitorLastMessageTs },
			token: { $exists: false },
		};

		return this.findOne(query, { sort: { ts: 1 } });
	}

	findAllImportedMessagesWithFilesToDownload() {
		const query = {
			'_importFile.downloadUrl': {
				$exists: true,
			},
			'_importFile.rocketChatUrl': {
				$exists: false,
			},
			'_importFile.downloaded': {
				$ne: true,
			},
			'_importFile.external': {
				$ne: true,
			},
		};

		return this.find(query);
	}
}

export default new Messages();
