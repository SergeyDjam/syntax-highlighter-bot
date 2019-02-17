/* eslint-disable no-console */
import Knex from 'knex'
import webshot from 'webshot'
import Telegraf from 'telegraf'
import Markup from 'telegraf/markup'

import dbConfig from '../knexfile'
import { webshotOptions, ENV } from './config/config'
import { messages, themes, langs } from './config/messages'
import {
  getPath, getUserPath, getThemeSlug, getThemeName, getImageFileName,
  isExisted, getFileURL, getPhotoData, isPrivateChat, chatUser, themesKeyboard,
  replyWithPhoto, replyWithMediaGroup, onError, clearFolder, getWebShot,
} from './config/methods'

import Server from './server'

import UserModel from './model/User/user-model'
import ChatModel from './model/Chat/chat-model'
import ChunkModel from './model/Chunk/chunk-model'


const knex = Knex(dbConfig[ENV.NODE_ENV])

ChatModel.knex(knex)
UserModel.knex(knex)
ChunkModel.knex(knex)

const server = new Server(new Telegraf(ENV.BOT_TOKEN, {
  telegram: { webhookReply: true },
}))

/**
 * Log middleware
 */
server.bot.use((ctx, next) => {
  const start = Date.now()

  return next(ctx).then(() => {
    console.log(`
${JSON.stringify(ctx.update, null, '  ')}
----------------------------------------
Response time ${Date.now() - start}ms
========================================`)
  })
})

/**
 * User middleware
 */
server.bot.use((ctx, next) => ctx.state.user
  ? next(ctx)
  : UserModel.store(ctx, next))

const startCommand = async (ctx) => {
  ctx.reply('fix')
  if (isPrivateChat(ctx)) {
    await ctx.replyWithMarkdown(
      messages.welcomeUser(ctx.state.user || chatUser(ctx)),
      { ...Markup.removeKeyboard().extra(), disable_web_page_preview: true }
    )
    return
  }
  const message = await ctx.replyWithMarkdown(
    messages.themeGroup,
    { ...Markup.removeKeyboard().extra(), disable_web_page_preview: true }
  )

  setTimeout(() => {
    ctx.deleteMessage(message.message_id)
  }, 10000)
}

/**
 * Start bot command
 */
server.bot.command('/start', startCommand)
server.bot.command('/start@cris_highlight_bot', startCommand)

const langsCommand = async (ctx) => {
  ctx.reply('fix')
  if (isPrivateChat(ctx)) {
    await ctx.replyWithMarkdown(messages.langsList())
    return
  }
  const message = await ctx.replyWithMarkdown(messages.themeGroup)

  setTimeout(() => {
    ctx.deleteMessage(message.message_id)
  }, 10000)
}

/**
 * Show languages list
 */
server.bot.command('/langs', langsCommand)
server.bot.command('/langs@cris_highlight_bot', langsCommand)

const themeCommand = async (ctx) => {
  ctx.reply('fix')
  if (isPrivateChat(ctx)) {
    await ctx.replyWithMarkdown(
      messages.themeChoose(ctx.state.user.theme),
      Markup.keyboard(themesKeyboard(themes)).oneTime().resize().extra()
    )
    return
  }
  const message = await ctx.replyWithMarkdown(messages.themeGroup)

  setTimeout(() => {
    ctx.deleteMessage(message.message_id)
  }, 10000)
}

/**
 * Show themes list
 */
server.bot.command('/theme', themeCommand)
server.bot.command('/theme@cris_highlight_bot', themeCommand)

/**
 * Theme choose command
 */
server.bot.hears(/^🎨 (.+)/, (ctx) => {
  const themeSlug = getThemeSlug(ctx.match[1])
  const themeName = getThemeName(themeSlug)

  if (!themes.includes(themeSlug)) return false

  const body = messages.demoCode(themeName)
  const filePath = getPath(getImageFileName(body, themeSlug))

  return webshot(messages.getHtml(body, themeSlug), filePath, webshotOptions, (err) => {
    if (err) return console.log(err)

    const button = Markup.callbackButton(
      `Apply ${themeName} theme`,
      `/apply/${themeSlug}`
    )

    ctx.replyWithChatAction('upload_photo')

    return ctx.replyWithPhoto(
      { url: getFileURL(filePath) },
      Markup.inlineKeyboard([button]).extra()
    )
  })
})

/**
 * Save theme
 */
server.bot.action(/^\/apply\/(.+)$/, (ctx) => UserModel.applyTheme(
  chatUser(ctx),
  getThemeName(ctx.match[1]),
  (user) => {
    ctx.answerCbQuery()
    ctx.replyWithMarkdown(
      messages.themeChanged(user),
      Markup.removeKeyboard().extra()
    )
  }
))

/**
 * Catch code message
 */
server.bot.entity(({ type }) => type === 'pre', async (ctx) => {
  const images = await Promise.all(ctx.message.entities
    .filter(({ type }) => type === 'pre')
    .map(async (entity) => {
      let lang
      let full
      let code = ctx.message.text.slice(entity.offset, entity.offset + entity.length)
      const match = code.match(/^(\w+)\n/)
      const themeSlug = ctx.state && ctx.state.user ? ctx.state.user.theme : 'github'

      if (match && match[1] && langs.includes(match[1])) {
        [full, lang] = match
        code = code.replace(new RegExp(full, 'i'), '')
      }
      else {
        lang = 'auto'
        code = code.replace(new RegExp('\\n', 'i'), '')
      }

      const html = messages.getHtml(code, themeSlug, lang !== 'auto' && lang)
      const filename = getImageFileName(html, themeSlug)
      let imagePath = getUserPath(ctx, filename)

      ChunkModel.store({
        userId: ctx.state && +ctx.state.user.id,
        chatId: +ctx.chat.id,
        filename,
        lang,
        source: code,
      }, () => {})

      if (!isExisted(imagePath)) {
        imagePath = await getWebShot(html, imagePath, webshotOptions)
          .catch(console.log)
      }

      return imagePath
    }))

  if (images.length === 0) {
    return
  }

  if (images.length === 1) {
    return replyWithPhoto(ctx, images[0])
  }

  return replyWithMediaGroup(ctx, images)
})

/**
 * Handle remove action.
 */
server.bot.action(/^remove::(\d+)$/, async (ctx) => {
  ctx.answerCbQuery()
  if (Number(ctx.match[1]) === ctx.update.callback_query.from.id) {
    await ctx.telegram.deleteMessage(
      ctx.update.callback_query.message.chat.id,
      ctx.update.callback_query.message.message_id
    )
    ctx.answerCbQuery('Message removed.')
    return
  }
  ctx.answerCbQuery('Sorry. Only authors are allowed to remove messages!')
})

/**
 * Inline query
 */
// server.bot.on('inline_query', (ctx) => {
//   let code = ctx.update.inline_query.query
//   const match = code.match(/^(\w+)\n/)
//   let lang = match && match[1]
//   const theme = ctx.state && ctx.state.user ? ctx.state.user.theme : 'github'

//   clearFolder(ctx.state && ctx.state.user)

//   if (match && langs.includes(lang)) {
//     code = code.replace(new RegExp(match[0], 'i'), '')
//   }
//   else {
//     lang = undefined
//   }

//   const html = messages.getHtml(code, theme, lang)
//   const imagePath = getUserPath(ctx, getImageFileName(html, theme))

//   if (isExisted(imagePath)) {
//     return ctx.answerInlineQuery([getPhotoData(imagePath)])
//   }

//   // console.log(html, imagePath, webshotOptions)

//   return webshot(html, imagePath, webshotOptions, (err) => {
//     if (err) return console.log(err)

//     return ctx.answerInlineQuery([getPhotoData(imagePath.replace(
//       '/home/dev812/web/syntax-highlighter-bot/images/',
//       ''
//     ))])
//   })
// })
// ctx.telegram.answerInlineQuery(ctx.inlineQuery.id, result)

/**
 * Bot was added to a group
 */
// server.bot.on(['new_chat_members'], (ctx) => {
//   if (ctx.message.new_chat_member.username !== ENV.BOT_USER) return

//   const onSuccess = () => ctx.replyWithMarkdown(messages.welcomeGroup())

//   ChatModel.query()
//     .findById(+ctx.chat.id)
//     .then((chat) => chat
//       ? ChatModel.query()
//         .patchAndFetchById(+chat.id, { active: true })
//         .then(onSuccess)
//         .catch(onError)
//       : ChatModel.query()
//         .insert({
//           id: +ctx.chat.id,
//           title: ctx.chat.title,
//           type: ctx.chat.type,
//           active: true,
//         })
//         .then(onSuccess)
//         .catch(onError))
//     .catch(onError)
// })

/**
 * Bot was removed from group
 */
// server.bot.on(['left_chat_member'], (ctx) => {
//   if (ctx.message.left_chat_member.username !== ENV.BOT_USER) return

//   ChatModel.query()
//     .patchAndFetchById(+ctx.chat.id, { active: false })
//     .then()
//     .catch(onError)
// })
