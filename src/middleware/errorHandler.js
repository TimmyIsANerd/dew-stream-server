export const errorHandler = async (c, next) => {
  try {
    await next()
  } catch (error) {
    console.error('Error:', error)

    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message)
      return c.json({ error: 'Validation Error', details: errors }, 400)
    }

    if (error.code === 11000) {
      const field = Object.keys(error.keyValue)[0]
      return c.json({ error: 'Duplicate', message: `${field} already exists` }, 400)
    }

    return c.json({ error: 'Internal Server Error' }, 500)
  }
}
