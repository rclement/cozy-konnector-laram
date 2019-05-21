const {
  BaseKonnector,
  normalizeFilename,
  requestFactory,
  signin,
  scrape,
  saveBills,
  log
} = require('cozy-konnector-libs')

const moment = require('moment')

const request = requestFactory({
  debug: false,
  cheerio: true,
  json: false,
  jar: true
})

// NOTE: currently there is a chain certificate issue with moncompte.laram.fr
// so all requests must manually add the following option: { rejectUnauthorized: false }

const vendor = 'laram'
const currency = '€'
const baseUrl = 'https://moncompte.laram.fr'
const loginUrl = `${baseUrl}`
const reimbursementsListUrl = `${baseUrl}/celro/assure/action/rbt`

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  log('info', 'Fetching the list of reimbursements')
  const $ = await request(reimbursementsListUrl, { rejectUnauthorized: false })

  log('info', 'Parsing list of reimbursements')
  const reimbursements = await parseReimbursements($)

  log('info', 'Saving data to Cozy')
  await saveBills(reimbursements, fields, {
    identifiers: [vendor]
  })
}

// this shows authentication using the [signin function](https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#module_signin)
// even if this in another domain here, but it works as an example
function authenticate(username, password) {
  return signin({
    url: loginUrl,
    formSelector: 'form#fm1',
    formData: {
      username: username,
      password: password
    },
    rejectUnauthorized: false,
    validate: (statusCode, $) => {
      return $(`a[href='/celro/assure/action/logout']`).length >= 1
    }
  })
}

// The goal of this function is to parse a html page wrapped by a cheerio instance
// and return an array of js objects which will be saved to the cozy by saveBills (https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#savebills)
async function parseReimbursements($) {
  const reimbursements = scrape(
    $,
    {
      date: {
        sel: 'td a',
        parse: parseReimbursementDate
      },
      amount: {
        sel: 'td a',
        parse: parseReimbursementAmount
      },
      url: {
        sel: 'td a',
        attr: 'href',
        parse: url => `${baseUrl}${url}`
      }
    },
    'tbody.links tr'
  )

  let documents = []
  for (let r of reimbursements) {
    const $details = await request(r.url, { rejectUnauthorized: false })
    const beneficiary = $details('div.remb_description div.col-md-12')
      .text()
      .replace('Bénéficiaire :', '')
      .trim()
    const url = $details('div.ficheDetail ul li.item > a').attr('href')
    const fileurl = `${baseUrl}${url}`
    const date = r.date.toDate()
    const filename = normalizeFilename(
      `${r.date.format('YYYY-MM-DD')}_${vendor}_${r.amount}${currency}.pdf`
    )

    documents.push({
      vendor: vendor,
      date: date,
      type: 'health_costs',
      subtype: 'reimbursement',
      isRefund: true,
      amount: r.amount,
      currency: currency,
      beneficiary: beneficiary,
      fileurl: fileurl,
      filename: filename,
      metadata: {
        importDate: new Date(),
        version: 1
      },
      requestOptions: {
        rejectUnauthorized: false
      }
    })
  }

  return documents
}

function parseReimbursementDate(date) {
  const dateFormat = 'DD/MM/YYYY'
  return moment.utc(date.slice(0, dateFormat.length), dateFormat)
}

function parseReimbursementAmount(amount) {
  const dateFormat = 'DD/MM/YYYY'
  return parseFloat(
    amount
      .slice(0, amount.indexOf(currency) - 1)
      .slice(dateFormat.length + '\n\t\t\t\t\t\t'.length)
      .replace(',', '.')
  )
}
